"""Cloud Agent gateway: plan-only, never writes events, never persists bodies."""

import hashlib
import json
import re
import threading
import time
import uuid
from copy import deepcopy
from datetime import date as date_type, datetime, timedelta, timezone
from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ... import models
from ...config import settings
from .provider import FakeProvider, OpenAICompatibleProvider, ProviderError


class AgentError(Exception):
    def __init__(self, status_code: int, code: str, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.code = code
        self.detail = detail


_CREATE_EVENT_PROPERTIES = {
    "event": {"type": "string", "description": "任务标题。"},
    "date": {"type": "string", "description": "日期，格式 YYYY-MM-DD。"},
    "time": {"type": "string", "description": "时间 HH:mm，可省略。"},
    "location": {"type": "string"},
    "note": {"type": "string"},
    "urgency": {"type": "string", "enum": ["normal", "high"]},
    "isDeadline": {"type": "boolean"},
    "startDate": {"type": "string", "description": "Deadline 开始日 YYYY-MM-DD。"},
    "deadlineDate": {"type": "string", "description": "Deadline 截止日 YYYY-MM-DD。"},
    "isRecurring": {"type": "boolean"},
    "recurringType": {"type": "string", "enum": ["daily", "weekly", "monthly"]},
    "recurringDays": {"type": "array", "items": {"type": "integer", "minimum": 0, "maximum": 6}, "description": "每周重复的星期(0=周日…6=周六)，可多个。"},
    "recurringMonthDays": {"type": "array", "items": {"type": "integer", "minimum": 1, "maximum": 31}, "description": "每月重复的日期 1-31，可多个；短月份不存在的日期自动跳过。"},
    "endDate": {"type": "string", "description": "重复结束日 YYYY-MM-DD，可省略。"},
    "isLongTerm": {"type": "boolean", "description": "长期任务：自开始日起每天显示直到完成。"},
    "targetDurationMinutes": {"type": "integer", "minimum": 1, "description": "专注目标时长(分钟)，可省略。"},
}

_OPTION_LABEL_MAX = 40
_MAX_OPTIONS = 4

TOOL_DEFINITIONS = {
    "list_events": {
        "type": "function",
        "function": {
            "name": "list_events",
            "description": (
                "查询当前日程。修改或删除前必须先查询以取得准确 ID。"
                "date 查询单个本地日历日；start_date/end_date 查询包含首尾的日期范围，"
                "两者必须同时提供。日期筛选按任务在客户端的实际显示日匹配。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "keyword": {"type": "string", "description": "标题关键词。"},
                    "date": {"type": "string", "description": "特定日期 YYYY-MM-DD。"},
                    "start_date": {"type": "string", "description": "范围开始日 YYYY-MM-DD（含）。"},
                    "end_date": {"type": "string", "description": "范围结束日 YYYY-MM-DD（含）。"},
                },
            },
        },
    },
    "create_event": {
        "type": "function",
        "function": {
            "name": "create_event",
            "description": "规划创建一条日程(普通 / Deadline / 每周或每月重复 / 长期任务)。动作由客户端审批后统一执行。日期一律使用 YYYY-MM-DD，时间使用 HH:mm。",
            "parameters": {
                "type": "object",
                "properties": deepcopy(_CREATE_EVENT_PROPERTIES),
                "required": ["event", "date"],
            },
        },
    },
    "propose_event_options": {
        "type": "function",
        "function": {
            "name": "propose_event_options",
            "description": (
                "用户想新增日程但说法模棱两可（未说时间、是否重复等）时，规划 2-4 个互斥的候选创建方案，"
                "由用户在客户端只选其一。例如“提醒我吃晚饭”：不设时间 / 推测一个时间 / 每天重复。"
                "每个 option.event 的字段与 create_event 完全相同；任一方案无效则整组不生成。"
                "不要对同一需求再额外调用 create_event。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "options": {
                        "type": "array",
                        "minItems": 2,
                        "maxItems": 4,
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string", "description": "方案简短说明，如“每天 18:30 重复”。"},
                                "event": {
                                    "type": "object",
                                    "description": "与 create_event 参数相同的日程字段。",
                                    "properties": deepcopy(_CREATE_EVENT_PROPERTIES),
                                    "required": ["event", "date"],
                                },
                            },
                            "required": ["label", "event"],
                        },
                    },
                },
                "required": ["options"],
            },
        },
    },
    "update_event": {
        "type": "function",
        "function": {
            "name": "update_event",
            "description": "规划修改已有日程。必须先 list_events 并使用其真实 ID。默认仅修改 effective_date（默认今天）及以后；跨边界任务由客户端保留历史并分割未来。支持全部日程类型及类型转换。只改循环/长期任务的某一天时用 scope=single，effective_date 为那一天，且只能改 event/time/location/note/urgency；对已跳过的那天单次修改会恢复该次。",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"description": "日程 ID。"},
                    "event": {"type": "string"},
                    "date": {"type": "string"},
                    "time": {"type": "string"},
                    "location": {"type": "string"},
                    "note": {"type": "string"},
                    "urgency": {"type": "string", "enum": ["normal", "high"]},
                    "calendar": {"type": "string"},
                    "event_type": {"type": "string", "enum": ["normal", "deadline", "recurring", "long_term"], "description": "目标日程类型；用于显式类型转换。"},
                    "isDeadline": {"type": "boolean"},
                    "startDate": {"type": "string"},
                    "deadlineDate": {"type": "string"},
                    "isRecurring": {"type": "boolean"},
                    "recurringType": {"type": "string", "enum": ["daily", "weekly", "monthly"]},
                    "recurringDays": {"type": "array", "items": {"type": "integer", "minimum": 0, "maximum": 6}},
                    "recurringMonthDays": {"type": "array", "items": {"type": "integer", "minimum": 1, "maximum": 31}},
                    "endDate": {"type": ["string", "null"], "description": "循环结束日；null 表示无结束日期。"},
                    "isLongTerm": {"type": "boolean"},
                    "targetDurationMinutes": {"type": ["integer", "null"], "minimum": 0},
                    "scope": {"type": "string", "enum": ["future", "all", "past", "single"], "default": "future", "description": "future: effective_date 及以后；past: effective_date 及以前；all: 整条；single: 仅 effective_date 当天这一次（其余日期不变）。"},
                    "effective_date": {"type": "string", "description": "范围边界 YYYY-MM-DD；省略时执行器强制使用请求 today。"},
                },
                "required": ["id"],
            },
        },
    },
    "delete_event": {
        "type": "function",
        "function": {
            "name": "delete_event",
            "description": "规划删除已有日程。必须先 list_events 并使用其真实 ID。默认仅删除 effective_date（默认今天）及以后，跨边界系列保留历史。只跳过循环/长期任务的某一天（如请假）用 scope=single。",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"description": "日程 ID。"},
                    "scope": {"type": "string", "enum": ["future", "all", "past", "single"], "default": "future", "description": "single: 只跳过 effective_date 当天这一次。"},
                    "effective_date": {"type": "string", "description": "范围边界 YYYY-MM-DD；省略时使用请求 today。"},
                },
                "required": ["id"],
            },
        },
    },
}


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^\d{1,2}:\d{2}$")


def _clean_date(value) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not _DATE_RE.match(text):
        return ""
    try:
        return date_type.fromisoformat(text).isoformat()
    except ValueError:
        return ""


def _clean_time(value) -> str:
    text = str(value or "").strip()
    if not _TIME_RE.match(text):
        return ""
    hour, minute = (int(part) for part in text.split(":"))
    return f"{hour:02d}:{minute:02d}" if hour <= 23 and minute <= 59 else ""


def _int_list(value, low: int, high: int) -> list:
    items = []
    if isinstance(value, list):
        for item in value:
            try:
                num = int(item)
            except (TypeError, ValueError):
                continue
            if low <= num <= high:
                if num not in items:
                    items.append(num)
    return items


_EDITABLE_FIELDS = {
    "event", "date", "time", "location", "note", "urgency", "calendar",
    "isDeadline", "startDate", "deadlineDate", "isRecurring", "recurringType",
    "recurringDays", "recurringMonthDays", "endDate", "isLongTerm",
    "targetDurationMinutes",
}

# Fields a single occurrence (scope=single) may override; mirrors EventStore OCCURRENCE_FIELDS.
_OCCURRENCE_FIELDS = {"event", "time", "location", "note", "urgency"}

# Above this many days, a range check with skippedDates stops iterating day by day.
_SKIP_SCAN_LIMIT_DAYS = 370


def _skipped_dates(event: dict) -> set:
    raw = event.get("skippedDates")
    return {_clean_date(item) for item in raw} - {""} if isinstance(raw, list) else set()


def _within_active_bounds(event: dict, date_key: str) -> bool:
    active_start = _clean_date(event.get("activeStartDate"))
    active_end = _clean_date(event.get("activeEndDate"))
    return not ((active_start and date_key < active_start) or (active_end and date_key > active_end))


def _event_occurs_on(event: dict, date_key: str) -> bool:
    """Mirror EventStore's local-date display rules without timezone conversion."""
    if date_key in _skipped_dates(event):
        return False
    return _scheduled_ignoring_skips(event, date_key)


def _scheduled_ignoring_skips(event: dict, date_key: str) -> bool:
    if not _within_active_bounds(event, date_key):
        return False
    if event.get("isLongTerm"):
        start = _clean_date(event.get("startDate") or event.get("date"))
        if not start or date_key < start:
            return False
        if event.get("isCompleted"):
            return date_key <= (_clean_date(event.get("completedDate")) or start)
        return True
    if event.get("isDeadline"):
        if event.get("isDeadlineCompleted"):
            return _clean_date(event.get("deadlineCompletedDate")) == date_key
        start = _clean_date(event.get("startDate") or event.get("date"))
        return bool(start and date_key >= start)
    if event.get("isRecurring"):
        start = _clean_date(event.get("startDate") or event.get("date"))
        end = _clean_date(event.get("endDate"))
        if not start or date_key < start or (end and date_key > end):
            return False
        current = datetime.strptime(date_key, "%Y-%m-%d")
        recurring_type = event.get("recurringType") or "daily"
        if recurring_type == "weekly":
            return (current.weekday() + 1) % 7 in _int_list(event.get("recurringDays"), 0, 6)
        if recurring_type == "monthly":
            month_days = _int_list(event.get("recurringMonthDays"), 1, 31)
            return current.day in month_days if month_days else current.day == datetime.strptime(start, "%Y-%m-%d").day
        return recurring_type == "daily"
    if event.get("isCompleted"):
        return _clean_date(event.get("completedDate")) == date_key
    return _clean_date(event.get("date")) == date_key


def _event_occurs_between(event: dict, start: str, end: str) -> bool:
    if not _occurs_between_ignoring_skips(event, start, end):
        return False
    if not _skipped_dates(event):
        return True
    cursor = datetime.strptime(start, "%Y-%m-%d")
    boundary = datetime.strptime(end, "%Y-%m-%d")
    if (boundary - cursor).days > _SKIP_SCAN_LIMIT_DAYS:
        return True
    while cursor <= boundary:
        if _event_occurs_on(event, cursor.strftime("%Y-%m-%d")):
            return True
        cursor += timedelta(days=1)
    return False


def _occurs_between_ignoring_skips(event: dict, start: str, end: str) -> bool:
    active_start = _clean_date(event.get("activeStartDate"))
    active_end = _clean_date(event.get("activeEndDate"))
    effective_start = max(start, active_start) if active_start else start
    effective_end = min(end, active_end) if active_end else end
    if effective_start > effective_end:
        return False
    if event.get("isLongTerm"):
        event_start = _clean_date(event.get("startDate") or event.get("date"))
        event_end = _clean_date(event.get("completedDate")) if event.get("isCompleted") else "9999-12-31"
        return bool(event_start and event_start <= effective_end and (event_end or event_start) >= effective_start)
    if event.get("isDeadline"):
        if event.get("isDeadlineCompleted"):
            completed = _clean_date(event.get("deadlineCompletedDate"))
            return bool(completed and effective_start <= completed <= effective_end)
        event_start = _clean_date(event.get("startDate") or event.get("date"))
        return bool(event_start and event_start <= effective_end)
    if not event.get("isRecurring"):
        event_date = _clean_date(event.get("completedDate") if event.get("isCompleted") else event.get("date"))
        return bool(event_date and effective_start <= event_date <= effective_end)
    event_start = _clean_date(event.get("startDate") or event.get("date"))
    event_end = _clean_date(event.get("endDate")) or effective_end
    effective_start = max(effective_start, event_start) if event_start else ""
    effective_end = min(effective_end, event_end)
    if not effective_start or effective_start > effective_end:
        return False
    recurring_type = event.get("recurringType") or "daily"
    if recurring_type == "daily":
        return True
    lookahead = 7 if recurring_type == "weekly" else 62
    cursor = datetime.strptime(effective_start, "%Y-%m-%d")
    boundary = min(datetime.strptime(effective_end, "%Y-%m-%d"), cursor + timedelta(days=lookahead))
    while cursor <= boundary:
        if _event_occurs_on(event, cursor.strftime("%Y-%m-%d")):
            return True
        cursor += timedelta(days=1)
    return False


def _list_window(args: dict):
    single_raw = str(args.get("date") or "").strip()
    start_raw = str(args.get("start_date") or "").strip()
    end_raw = str(args.get("end_date") or "").strip()
    if single_raw and (start_raw or end_raw):
        return None, None, "date 不能与 start_date/end_date 同时使用。"
    if single_raw:
        single = _clean_date(single_raw)
        return (single, single, None) if single else (None, None, "日期无效：请使用真实的 YYYY-MM-DD 日期。")
    if bool(start_raw) != bool(end_raw):
        return None, None, "日期范围必须同时提供 start_date 和 end_date。"
    if start_raw:
        start, end = _clean_date(start_raw), _clean_date(end_raw)
        if not start or not end:
            return None, None, "日期范围无效：请使用真实的 YYYY-MM-DD 日期。"
        if end < start:
            return None, None, "end_date 不能早于 start_date。"
        return start, end, None
    return None, None, None


_DRAFT_META_KEYS = {"id", "_draft_status", "_choice_group_id", "_option_label"}


class PlanningContext:
    def __init__(
        self,
        snapshot: List[dict],
        pending_drafts: Optional[List[dict]] = None,
        today: Optional[str] = None,
    ):
        self.events = deepcopy(snapshot if isinstance(snapshot, list) else [])
        self.actions = []
        self.cancelled_draft_ids = set()
        self.today = _clean_date(today) or datetime.now(timezone(timedelta(hours=8))).date().isoformat()
        self.listed_event_ids = set()
        for draft in pending_drafts or []:
            draft_id = str(draft.get("draft_id") or "")
            event = deepcopy(draft.get("event") or {})
            if not draft_id or not event:
                continue
            event["id"] = draft_id
            event["_draft_status"] = "pending_approval"
            if draft.get("choice_group_id"):
                event["_choice_group_id"] = str(draft["choice_group_id"])
                event["_option_label"] = str(draft.get("option_label") or "")
            self.events.append(event)

    @staticmethod
    def _public_event(event: dict) -> dict:
        return {
            key: value
            for key, value in event.items()
            if key not in _DRAFT_META_KEYS
        }

    @staticmethod
    def _choice_meta(event: dict) -> dict:
        if not event.get("_choice_group_id"):
            return {}
        return {
            "choice_group_id": event["_choice_group_id"],
            "option_label": event.get("_option_label") or "",
        }

    def _create_action(self, event: dict) -> dict:
        return {
            "type": "create",
            "draft_id": str(event["id"]),
            "event": self._public_event(event),
            **self._choice_meta(event),
        }

    def _add_create_draft(self, event: dict, group_id: str = "", label: str = "") -> dict:
        event["id"] = f"draft-{uuid.uuid4()}"
        event["_draft_status"] = "pending_approval"
        if group_id:
            event["_choice_group_id"] = group_id
            event["_option_label"] = label
        self.events.append(event)
        self.actions.append(self._create_action(event))
        return event

    def pending_drafts(self) -> List[dict]:
        return [
            {
                "draft_id": str(event["id"]),
                "status": "pending_approval",
                "event": self._public_event(event),
                **self._choice_meta(event),
            }
            for event in self.events
            if event.get("_draft_status") == "pending_approval"
            and str(event.get("id")) not in self.cancelled_draft_ids
        ]

    @staticmethod
    def _event_bounds(event: dict) -> tuple[str, Optional[str]]:
        start = _clean_date(event.get("startDate") or event.get("date"))
        if event.get("isRecurring"):
            return start, _clean_date(event.get("endDate")) or None
        if event.get("isDeadline"):
            if event.get("isDeadlineCompleted"):
                completed = _clean_date(event.get("deadlineCompletedDate"))
                return start, completed or _clean_date(event.get("deadlineDate")) or start
            return start, None
        if event.get("isLongTerm"):
            end = _clean_date(event.get("completedDate")) if event.get("isCompleted") else ""
            return start, end or None
        return start, _clean_date(event.get("date")) or start

    def _scope(self, args: dict) -> tuple[str, str, Optional[dict]]:
        scope = args.get("scope") if args.get("scope") in {"future", "all", "past", "single"} else "future"
        effective = _clean_date(args.get("effective_date")) or self.today
        if args.get("effective_date") is not None and not _clean_date(args.get("effective_date")):
            return scope, effective, {"success": False, "message": "effective_date 必须是有效的 YYYY-MM-DD 日期。"}
        return scope, effective, None

    @staticmethod
    def _updates(args: dict) -> tuple[dict, Optional[str]]:
        updates = {key: deepcopy(value) for key, value in args.items() if key in _EDITABLE_FIELDS}
        if "event" in updates:
            updates["event"] = str(updates["event"] or "").strip()
            if not updates["event"]:
                return {}, "日程标题不能为空。"
        for key in ("date", "startDate", "deadlineDate"):
            if key in updates:
                cleaned = _clean_date(updates[key])
                if not cleaned:
                    return {}, f"{key} 必须是有效的 YYYY-MM-DD 日期。"
                updates[key] = cleaned
        if "endDate" in updates and updates["endDate"] is not None:
            cleaned = _clean_date(updates["endDate"])
            if not cleaned:
                return {}, "endDate 必须是有效的 YYYY-MM-DD 日期或 null。"
            updates["endDate"] = cleaned
        if "time" in updates:
            raw_time = updates["time"]
            updates["time"] = _clean_time(raw_time)
            if raw_time and not updates["time"]:
                return {}, "time 必须是 HH:mm。"
        if "urgency" in updates:
            if updates["urgency"] not in {"normal", "high"}:
                return {}, "urgency 必须是 normal 或 high。"
        if "recurringType" in updates and updates["recurringType"] not in {"daily", "weekly", "monthly"}:
            return {}, "recurringType 必须是 daily、weekly 或 monthly。"
        if "recurringDays" in updates:
            updates["recurringDays"] = _int_list(updates["recurringDays"], 0, 6)
        if "recurringMonthDays" in updates:
            updates["recurringMonthDays"] = _int_list(updates["recurringMonthDays"], 1, 31)
        if "targetDurationMinutes" in updates and updates["targetDurationMinutes"] is not None:
            try:
                updates["targetDurationMinutes"] = int(updates["targetDurationMinutes"])
            except (TypeError, ValueError):
                return {}, "targetDurationMinutes 必须是非负整数或 null。"
            if updates["targetDurationMinutes"] < 0:
                return {}, "targetDurationMinutes 必须是非负整数或 null。"
        if "targetDurationMinutes" in updates:
            minutes = updates["targetDurationMinutes"] or 0
            updates["targetDurationSeconds"] = minutes * 60
        event_type = args.get("event_type")
        if event_type:
            updates.update({
                "isDeadline": event_type == "deadline",
                "isRecurring": event_type == "recurring",
                "isLongTerm": event_type == "long_term",
            })
        return updates, None

    def _scope_applies(self, event: dict, scope: str, effective: str) -> bool:
        start, end = self._event_bounds(event)
        if scope == "all":
            return True
        if scope == "future":
            return end is None or end >= effective
        return not start or start <= effective

    @staticmethod
    def _is_series(event: dict) -> bool:
        return bool(event.get("isRecurring") or event.get("isLongTerm"))

    def _plan_single_update(self, event: dict, event_id: str, updates: dict, date: str) -> dict:
        """scope=single: override one occurrence; the client stores it in occurrenceOverrides."""
        if event.get("isDeadline"):
            return {"success": False, "message": "Deadline 任务不支持单次修改，请使用 future 或 all。"}
        extra = sorted(set(updates) - _OCCURRENCE_FIELDS)
        if extra:
            return {
                "success": False,
                "message": f"单次修改只能改 event/time/location/note/urgency，不能改：{', '.join(extra)}。",
            }
        if not _scheduled_ignoring_skips(event, date):
            return {"success": False, "message": f"该日程在 {date} 没有安排，无法单次修改。"}
        if self._is_series(event):
            overrides = deepcopy(event.get("occurrenceOverrides") or {})
            overrides[date] = {**overrides.get(date, {}), **updates}
            event["occurrenceOverrides"] = overrides
            event["skippedDates"] = sorted(_skipped_dates(event) - {date})
        else:
            event.update(updates)
        self.actions.append({
            "type": "update", "id": event_id, "updates": updates,
            "scope": "single", "effective_date": date,
        })
        return {"success": True, "occurrence_date": date, "event": event}

    def _plan_single_delete(self, event: dict, event_id: str, date: str) -> dict:
        """scope=single: skip one occurrence; the client stores it in skippedDates."""
        if event.get("isDeadline"):
            return {"success": False, "message": "Deadline 任务不支持单次删除，请使用 future 或 all。"}
        if not _event_occurs_on(event, date):
            return {"success": False, "message": f"该日程在 {date} 没有安排（或已跳过），无法单次删除。"}
        if self._is_series(event):
            event["skippedDates"] = sorted(_skipped_dates(event) | {date})
            overrides = deepcopy(event.get("occurrenceOverrides") or {})
            overrides.pop(date, None)
            event["occurrenceOverrides"] = overrides
        else:
            self.events.remove(event)
        self.actions.append({
            "type": "delete", "id": event_id,
            "scope": "single", "effective_date": date,
        })
        return {"success": True, "skipped_date": date, "event": event}

    @staticmethod
    def _build_create_event(args: dict) -> tuple[Optional[dict], Optional[dict]]:
        """Validate create_event arguments into a draft body, or return an error result."""
        title = str(args.get("event") or "").strip()
        if not title:
            return None, {"success": False, "message": "日程标题不能为空。"}
        date = _clean_date(args.get("date"))
        if not date:
            return None, {
                "success": False,
                "message": "日期无效：请使用 YYYY-MM-DD 格式，例如 2026-08-20。",
            }
        raw_time = str(args.get("time") or "").strip()
        if raw_time and not _clean_time(raw_time):
            return None, {"success": False, "message": "时间无效：请使用 00:00-23:59。"}
        if sum(bool(args.get(key)) for key in ("isLongTerm", "isDeadline", "isRecurring")) > 1:
            return None, {"success": False, "message": "长期、Deadline 与循环任务类型不能同时设置。"}
        if args.get("urgency") not in {None, "normal", "high"}:
            return None, {"success": False, "message": "urgency 必须是 normal 或 high。"}
        event = {
            "event": title,
            "date": date,
            "time": _clean_time(raw_time),
            "location": str(args.get("location") or ""),
            "note": str(args.get("note") or ""),
            "urgency": "high" if args.get("urgency") == "high" else "normal",
        }
        if args.get("isLongTerm"):
            event["isLongTerm"] = True
            event["startDate"] = date
        elif args.get("isDeadline"):
            raw_start = str(args.get("startDate") or "").strip()
            raw_deadline = str(args.get("deadlineDate") or "").strip()
            start = _clean_date(raw_start) if raw_start else date
            deadline = _clean_date(raw_deadline) if raw_deadline else date
            if (raw_start and not start) or (raw_deadline and not deadline):
                return None, {"success": False, "message": "Deadline 日期必须是真实的 YYYY-MM-DD 日期。"}
            if deadline < start:
                return None, {
                    "success": False,
                    "message": "Deadline 截止日期不能早于开始日期。",
                }
            event["isDeadline"] = True
            event["date"] = start
            event["startDate"] = start
            event["deadlineDate"] = deadline
        if args.get("isRecurring") and not event.get("isLongTerm"):
            recurring_type = args.get("recurringType") or "daily"
            if recurring_type not in {"daily", "weekly", "monthly"}:
                return None, {"success": False, "message": "recurringType 必须是 daily、weekly 或 monthly。"}
            event["isRecurring"] = True
            event["startDate"] = date
            event["recurringType"] = recurring_type
            if event["recurringType"] == "weekly":
                days = _int_list(args.get("recurringDays"), 0, 6)
                if not days:
                    return None, {"success": False, "message": "每周循环必须至少提供一个 recurringDays。"}
                event["recurringDays"] = days
            elif event["recurringType"] == "monthly":
                days = _int_list(args.get("recurringMonthDays"), 1, 31)
                if days:
                    event["recurringMonthDays"] = days
            raw_end = str(args.get("endDate") or "").strip()
            end = _clean_date(raw_end)
            if raw_end and not end:
                return None, {"success": False, "message": "重复结束日期必须是真实的 YYYY-MM-DD 日期。"}
            if end:
                if end < event["date"]:
                    return None, {
                        "success": False,
                        "message": "重复结束日期不能早于开始日期。",
                    }
                event["endDate"] = end
        minutes = args.get("targetDurationMinutes")
        if minutes is not None:
            try:
                minutes = int(minutes)
            except (TypeError, ValueError):
                minutes = -1
            if minutes <= 0:
                return None, {
                    "success": False,
                    "message": "targetDurationMinutes 必须是正整数。",
                }
            event["targetDurationMinutes"] = minutes
        return event, None

    def execute(self, name: str, args: dict) -> dict:
        if name == "list_events":
            keyword = str(args.get("keyword") or "").lower().strip()
            start, end, error = _list_window(args)
            if error:
                return {"success": False, "message": error}
            results = [
                e for e in self.events
                if not keyword or keyword in str(e.get("event") or "").lower()
            ]
            if start:
                results = [event for event in results if _event_occurs_between(event, start, end)]
            rendered = []
            for event in results[:100]:
                item = deepcopy(event)
                meta = self._choice_meta(item)
                item.pop("_choice_group_id", None)
                item.pop("_option_label", None)
                if item.pop("_draft_status", None) == "pending_approval":
                    item["storage_status"] = "pending_approval_not_saved"
                    item.update(meta)
                else:
                    item["storage_status"] = "saved_event"
                rendered.append(item)
                if item.get("storage_status") == "saved_event":
                    self.listed_event_ids.add(str(item.get("id")))
            return {
                "success": True, "count": len(results), "events": rendered,
                "truncated": len(results) > len(rendered),
            }
        if name == "create_event":
            event, error = self._build_create_event(args)
            if error:
                return error
            self._add_create_draft(event)
            return {"success": True, "event": event}
        if name == "propose_event_options":
            options = args.get("options")
            if not isinstance(options, list) or not 2 <= len(options) <= _MAX_OPTIONS:
                return {"success": False, "message": f"options 必须包含 2-{_MAX_OPTIONS} 个候选方案。"}
            built = []
            for index, option in enumerate(options, start=1):
                if not isinstance(option, dict) or not isinstance(option.get("event"), dict):
                    return {"success": False, "message": f"第 {index} 个方案缺少 event。"}
                label = str(option.get("label") or "").strip()[:_OPTION_LABEL_MAX]
                if not label:
                    return {"success": False, "message": f"第 {index} 个方案缺少 label。"}
                event, error = self._build_create_event(option["event"])
                if error:
                    return {"success": False, "message": f"第 {index} 个方案无效：{error['message']}"}
                built.append((label, event))
            group_id = f"choice-{uuid.uuid4()}"
            drafts = [self._add_create_draft(event, group_id, label) for label, event in built]
            return {
                "success": True,
                "choice_group_id": group_id,
                "options": [
                    {"draft_id": draft["id"], "label": draft["_option_label"]}
                    for draft in drafts
                ],
                "note": "用户只能选其中一个方案，审批前都未写入日历。",
            }
        if name == "update_event":
            event_id = args.get("id")
            event = next(
                (e for e in self.events if str(e.get("id")) == str(event_id)), None
            )
            if not event:
                return {"success": False, "message": f"未找到日程 ID {event_id}"}
            if event.get("_draft_status") != "pending_approval" and str(event_id) not in self.listed_event_ids:
                return {"success": False, "message": "修改前必须先调用 list_events 获取真实 ID。"}
            updates, error = self._updates(args)
            if error:
                return {"success": False, "message": error}
            if not updates:
                return {"success": False, "message": "没有可修改的字段。"}
            if "date" in updates and (
                event.get("isLongTerm") or event.get("isDeadline") or event.get("isRecurring")
                or args.get("event_type") in {"long_term", "deadline", "recurring"}
            ):
                updates["startDate"] = updates["date"]
            scope, effective, scope_error = self._scope(args)
            if scope_error:
                return scope_error
            if scope == "single" and event.get("_draft_status") != "pending_approval":
                return self._plan_single_update(event, str(event_id), updates, effective)
            if event.get("_draft_status") != "pending_approval":
                if not self._scope_applies(event, scope, effective):
                    return {"success": False, "message": f"该日程不在 {scope} 范围内，未生成修改动作。"}
                prospective = {**event, **updates}
                if sum(bool(prospective.get(key)) for key in ("isLongTerm", "isDeadline", "isRecurring")) > 1:
                    return {"success": False, "message": "长期、Deadline 与循环任务类型不能同时设置。"}
                if prospective.get("isRecurring") and prospective.get("recurringType") == "weekly" and not _int_list(prospective.get("recurringDays"), 0, 6):
                    return {"success": False, "message": "每周循环必须至少提供一个 recurringDays。"}
                target_start, target_end = self._event_bounds(prospective)
                if target_start and target_end and target_end < target_start:
                    return {"success": False, "message": "修改后的结束日期不能早于开始日期。"}
                if scope == "future" and target_end is not None and target_end < effective:
                    return {"success": False, "message": "修改后的日程在 effective_date 之前结束。"}
                if scope == "past" and target_start and target_start > effective:
                    return {"success": False, "message": "修改后的日程在 effective_date 之后开始。"}
            event.update(updates)
            if event.get("_draft_status") == "pending_approval":
                self.actions = [
                    action for action in self.actions
                    if action.get("draft_id") != str(event_id)
                ]
                self.actions.append(self._create_action(event))
            else:
                self.actions.append({
                    "type": "update", "id": str(event_id), "updates": updates,
                    "scope": scope, "effective_date": effective,
                })
            return {"success": True, "event": event}
        if name == "delete_event":
            event_id = args.get("id")
            event = next(
                (e for e in self.events if str(e.get("id")) == str(event_id)), None
            )
            if not event:
                return {"success": False, "message": f"未找到日程 ID {event_id}"}
            if event.get("_draft_status") == "pending_approval":
                self.cancelled_draft_ids.add(str(event_id))
                self.events.remove(event)
                self.actions = [
                    action for action in self.actions
                    if action.get("draft_id") != str(event_id)
                ]
                return {
                    "success": True,
                    "cancelled_pending_draft": True,
                    "draft_id": str(event_id),
                }
            if str(event_id) not in self.listed_event_ids:
                return {"success": False, "message": "删除前必须先调用 list_events 获取真实 ID。"}
            scope, effective, scope_error = self._scope(args)
            if scope_error:
                return scope_error
            if scope == "single":
                return self._plan_single_delete(event, str(event_id), effective)
            if not self._scope_applies(event, scope, effective):
                return {"success": False, "message": f"该日程不在 {scope} 范围内，未生成删除动作。"}
            self.actions.append({
                "type": "delete", "id": str(event_id),
                "scope": scope, "effective_date": effective,
            })
            return {"success": True, "event": event}
        return {"success": False, "message": f"不支持的工具：{name}"}


_ALL_TOOL_NAMES = [
    "list_events", "create_event", "propose_event_options", "update_event", "delete_event",
]


def select_tools(message: Optional[str] = None) -> List[dict]:
    """Inject every tool definition on every round.

    Keyword/intent routing was removed: the model must be able to see every
    tool on each call so short, context-dependent phrases (e.g. "只改这一次")
    are never limited to a guessed subset.
    """
    return [TOOL_DEFINITIONS[name] for name in _ALL_TOOL_NAMES]


class AgentService:
    def __init__(self, provider_override=None):
        self._semaphore = threading.BoundedSemaphore(settings.ai_max_concurrency)
        self.provider_override = provider_override

    # ------------------------------------------------------------ sessions

    @staticmethod
    def _lock_session(db, user_id, session_id: str) -> None:
        key = f"{user_id}:{session_id}"
        digest = hashlib.sha256(key.encode("utf-8")).digest()
        lock_id = int.from_bytes(digest[:8], byteorder="big", signed=True)
        db.execute(select(func.pg_advisory_xact_lock(lock_id)))

    @staticmethod
    def _load_session(db, user_id, session_id: str):
        AgentService._lock_session(db, user_id, session_id)
        row = db.execute(
            select(models.AgentSession)
            .where(
                models.AgentSession.user_id == user_id,
                models.AgentSession.session_id == session_id,
            )
            .with_for_update()
        ).scalar_one_or_none()
        if row is None:
            return [], {}
        messages = list(row.messages) if isinstance(row.messages, list) else []
        state = deepcopy(row.state) if isinstance(row.state, dict) else {}
        return messages, state

    @staticmethod
    def _load_history(db, user_id, session_id: str) -> List[dict]:
        messages, _state = AgentService._load_session(db, user_id, session_id)
        return messages

    @staticmethod
    def _save_history(
        db,
        user_id,
        session_id: str,
        messages: List[dict],
        state: Optional[dict] = None,
    ) -> None:
        AgentService._lock_session(db, user_id, session_id)
        cap = max(2, settings.agent_history_messages)
        if cap % 2:
            cap -= 1
        row = db.execute(
            select(models.AgentSession)
            .where(
                models.AgentSession.user_id == user_id,
                models.AgentSession.session_id == session_id,
            )
            .with_for_update()
        ).scalar_one_or_none()
        merged = (list(row.messages) if row is not None and isinstance(row.messages, list) else [])
        merged.extend(messages)
        merged = merged[-cap:]
        now = datetime.now(timezone.utc)
        if row is None:
            db.add(models.AgentSession(
                user_id=user_id,
                session_id=session_id,
                messages=merged,
                state=deepcopy(state or {}),
                updated_at=now,
            ))
        else:
            row.messages = merged
            if state is not None:
                row.state = deepcopy(state)
            row.updated_at = now
        db.commit()
        if settings.agent_session_cleanup_after_write:
            try:
                AgentService._cleanup_expired_sessions(db)
            except Exception:
                db.rollback()

    @staticmethod
    def _apply_receipts(state: dict, receipts: List[dict]) -> dict:
        next_state = deepcopy(state or {})
        pending = list(next_state.get("pending_drafts") or [])
        for receipt in receipts or []:
            plan_id = str(receipt.get("plan_id") or "")
            draft_id = str(receipt.get("draft_id") or "")
            match = next((
                draft for draft in pending
                if draft.get("draft_id") == draft_id
                and str(draft.get("plan_id") or "") == plan_id
            ), None)
            if match is None:
                continue
            status = receipt.get("status")
            if status == "approved" and receipt.get("event_id"):
                pending.remove(match)
                group_id = match.get("choice_group_id")
                if group_id:
                    # Choosing one alternative implicitly rejects its siblings.
                    pending = [
                        draft for draft in pending
                        if draft.get("choice_group_id") != group_id
                    ]
                next_state["recent_reference"] = {
                    "storage_status": "saved_event",
                    "event_id": receipt.get("event_id"),
                    "event": deepcopy(match.get("event") or {}),
                }
            elif status == "rejected":
                pending.remove(match)
                next_state["recent_reference"] = {
                    "storage_status": "rejected_draft",
                    "draft_id": draft_id,
                }
            elif status in {"approved", "failed"}:
                match["last_receipt_status"] = "failed"
        next_state["pending_drafts"] = pending[-20:]
        return next_state

    @staticmethod
    def _state_for_model(state: dict) -> str:
        payload = {
            "pending_drafts": list(state.get("pending_drafts") or [])[-20:],
            "recent_reference": state.get("recent_reference"),
            "recent_tool_trace": list(state.get("tool_traces") or [])[-6:],
        }
        return _dump(payload)

    @staticmethod
    def _compact_tool_result(result: dict) -> dict:
        compact = deepcopy(result)
        if isinstance(compact.get("events"), list):
            compact["events"] = compact["events"][:20]
        return compact

    @staticmethod
    def _state_after_plan(
        previous: dict,
        context: PlanningContext,
        plan_id: str,
        tool_trace: List[dict],
    ) -> dict:
        state = deepcopy(previous or {})
        prior_by_id = {
            draft.get("draft_id"): draft
            for draft in state.get("pending_drafts") or []
        }
        current_action_ids = {
            action.get("draft_id")
            for action in context.actions
            if action.get("type") == "create" and action.get("draft_id")
        }
        pending = []
        for draft in context.pending_drafts():
            draft_id = draft["draft_id"]
            prior = prior_by_id.get(draft_id, {})
            draft["plan_id"] = plan_id if draft_id in current_action_ids else prior.get("plan_id")
            pending.append(draft)
        state["pending_drafts"] = pending[-20:]
        traces = list(state.get("tool_traces") or [])
        traces.extend(tool_trace)
        state["tool_traces"] = traces[-12:]
        state["last_plan_id"] = plan_id
        if context.actions:
            last = context.actions[-1]
            if last.get("draft_id"):
                state["recent_reference"] = {
                    "storage_status": "pending_approval_not_saved",
                    "draft_id": last["draft_id"],
                    "event": deepcopy(last.get("event") or {}),
                }
            elif last.get("id"):
                state["recent_reference"] = {
                    "storage_status": "saved_event",
                    "event_id": last["id"],
                }
        return state

    @staticmethod
    def _cleanup_expired_sessions(db) -> int:
        cutoff = datetime.now(timezone.utc) - timedelta(
            days=max(0, settings.agent_session_ttl_days)
        )
        result = db.execute(
            models.AgentSession.__table__.delete().where(
                models.AgentSession.updated_at < cutoff
            )
        )
        db.commit()
        return result.rowcount or 0


    # ------------------------------------------------------------------ budget

    def _admin_setting(self, db: Session, key: str, default: float) -> Optional[str]:
        row = db.execute(
            select(models.AdminSetting).where(models.AdminSetting.key == key)
        ).scalar_one_or_none()
        return row.value if row else None

    def ai_enabled(self, db: Session) -> bool:
        value = self._admin_setting(db, "ai_enabled", None)
        if value is not None:
            return value.strip().lower() in ("1", "true", "yes", "on")
        return settings.ai_enabled_default

    def ai_monthly_budget(self, db: Session) -> float:
        value = self._admin_setting(db, "ai_monthly_budget_usd", None)
        if value is not None:
            try:
                return float(value)
            except ValueError:
                pass
        return settings.ai_monthly_budget_usd

    def spent_this_month(self, db: Session) -> float:
        start = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        total = db.execute(
            select(func.coalesce(func.sum(models.AiUsage.estimated_cost_usd), 0.0)).where(
                models.AiUsage.created_at >= start,
                models.AiUsage.status == "success",
            )
        ).scalar()
        return float(total or 0.0)

    def _check_budget(self, db: Session) -> None:
        if not self.ai_enabled(db):
            raise AgentError(503, "ai_disabled", "AI 服务已被管理员关闭")
        budget = self.ai_monthly_budget(db)
        if budget > 0 and self.spent_this_month(db) >= budget:
            raise AgentError(429, "budget_exceeded", "AI 月度预算已用完，日历与同步功能不受影响")

    def _record_usage(
        self,
        db: Session,
        user_id,
        model: str,
        prompt_tokens: int,
        completion_tokens: int,
        latency_ms: int,
        status: str,
        error_code: Optional[str] = None,
    ) -> None:
        cost = (
            prompt_tokens * settings.ai_input_price_per_1k
            + completion_tokens * settings.ai_output_price_per_1k
        ) / 1000.0
        db.add(models.AiUsage(
            user_id=user_id,
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            estimated_cost_usd=round(cost, 8),
            latency_ms=latency_ms,
            status=status,
            error_code=error_code,
        ))
        db.commit()

    # ------------------------------------------------------------------ plan

    def _provider(self):
        if self.provider_override is not None:
            return self.provider_override
        if settings.ai_api_key or settings.ai_base_url:
            if not settings.ai_base_url:
                raise AgentError(503, "not_configured", "AI 服务未配置")
            return OpenAICompatibleProvider(
                settings.ai_base_url, settings.ai_api_key, settings.ai_timeout_seconds
            )
        raise AgentError(503, "not_configured", "AI 服务未配置")

    def plan(
        self,
        db: Session,
        user_id,
        message: str,
        snapshot,
        today: str,
        session_id: Optional[str],
        receipts: Optional[List[dict]] = None,
        continue_planning: bool = False,
    ) -> dict:
        clean_message = (message or "").strip()
        receipt_items = receipts or []
        if receipt_items and not continue_planning:
            started = time.monotonic()
            _history, session_state = self._load_session(db, user_id, session_id)
            session_state = self._apply_receipts(session_state, receipt_items)
            if session_state:
                self._save_history(db, user_id, session_id, [], session_state)
            plan_id = session_state.get("last_plan_id") or str(uuid.uuid4())
            return {
                "plan_id": plan_id,
                "message": "操作结果已记录。",
                "actions": [],
                "configured": True,
                "usage": {
                    "model": "receipt-only",
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "latency_ms": int((time.monotonic() - started) * 1000),
                },
                "budget": self._budget_info(db),
            }

        self._check_budget(db)
        acquired = self._semaphore.acquire(timeout=15.0)
        if not acquired:
            raise AgentError(503, "busy", "AI 服务繁忙，请稍后再试")
        started = time.monotonic()
        provider = None
        model = settings.ai_model or "default"
        try:
            provider = self._provider()
            history = []
            session_state = {}
            if session_id:
                history, session_state = self._load_session(db, user_id, session_id)
                history = history[-6:]
                session_state = self._apply_receipts(session_state, receipt_items)
            plan_id = str(uuid.uuid4())
            system = (
                "你是 HoYoCalendar 的日程执行助手。"
                f"今天是 {today}（UTC+8 北京时间）。日期一律使用 YYYY-MM-DD，时间使用 HH:mm。"
                "先理解用户目标，再使用工具规划必要动作。"
                "修改或删除前必须先 list_events，禁止猜测 ID。"
                "update_event/delete_event 的 scope 默认为 future，effective_date 默认为今天；"
                "只有用户明确要求全部或过去时才使用 all/past。跨越边界的系列由客户端分割，历史实例会保留。"
                "用户只想改循环/长期任务的某一天（如“明天上班改成七点”），用 update_event scope=single、"
                "effective_date=那一天，只改 event/time/location/note/urgency；"
                "只想跳过某一天（如“明天请假不去”），用 delete_event scope=single；"
                "“以后都不去了/删掉以后的”才用 delete_event scope=future。"
                "日程中的 occurrenceOverrides 是某天的单次调整，skippedDates 是已跳过的日期。"
                "Deadline 任务设置 isDeadline=true 并给出 startDate/deadlineDate；"
                "循环任务设置 isRecurring=true（每周用 recurringDays 0-6，每月用 recurringMonthDays 1-31，可多个，短月份自动跳过）；"
                "长期任务（每天显示直到完成）设置 isLongTerm=true。"
                "结构化会话状态中的 pending_approval_not_saved 表示尚未审批、绝未写入日历；"
                "用户说‘刚才那个/改成这样/继续’时，优先解析最近对话和结构化引用。"
                "用户只回复 1/2 等选项时，必须对应紧邻的助手选项，不得解释成日程序号。"
                "修改待审批草案时使用其 draft_id，仍返回待审批创建草案。"
                "不要声称待审批草案已经写入数据；工具成功后用简洁中文说明具体规划结果。"
                "用户想新增日程但时间、是否重复等关键信息模棱两可时（如“提醒我吃晚饭”），"
                "不要追问，改用 propose_event_options 给出 2-4 个互斥方案供用户选择，"
                "通常包括：不设时间（日期默认今天）、按常识推测一个时间、设为长期/每天重复；"
                "回复中用一句话说明各方案，并提示用户在下方选择其一。"
                "结构化状态中带 choice_group_id 的草案属于同一组互斥候选，用户只会批准其中一个。"
                "如果连要做什么都无法确定，先提出一个最关键的澄清问题，不调用写工具。"
                f"当前结构化会话状态：{self._state_for_model(session_state)}"
            )
            messages = [{"role": "system", "content": system}, *history]
            if snapshot:
                messages.append({
                    "role": "user",
                    "content": f"以下是当前日历快照（共 {len(snapshot)} 条）：\n{_render_snapshot(snapshot)}",
                })
            messages.append({"role": "user", "content": clean_message})
            tools = select_tools(clean_message)
            context = PlanningContext(snapshot, session_state.get("pending_drafts") or [], today=today)
            final_message = ""
            tool_trace = []
            total_prompt = 0
            total_completion = 0

            for _round in range(3):
                result = provider.complete(messages, tools, model)
                total_prompt += result.prompt_tokens
                total_completion += result.completion_tokens
                assistant_payload = {"role": "assistant", "content": result.content or ""}
                if result.tool_calls:
                    assistant_payload["tool_calls"] = [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                # OpenAI 线格式要求 arguments 为 JSON 字符串（DeepSeek 严格校验）
                                "arguments": json.dumps(call.arguments, ensure_ascii=False),
                            },
                        }
                        for call in result.tool_calls
                    ]
                messages.append(assistant_payload)
                if not result.tool_calls:
                    final_message = result.content or "处理完成。"
                    break
                for call in result.tool_calls:
                    result_payload = context.execute(call.name, call.arguments)
                    tool_trace.append({
                        "name": call.name,
                        "arguments": deepcopy(call.arguments),
                        "result": self._compact_tool_result(result_payload),
                    })
                    messages.append({
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": _dump(result_payload),
                    })

            if not final_message:
                final_message = (
                    f"已规划 {len(context.actions)} 项日程变更。"
                    if context.actions
                    else "已完成查询，没有需要写入的变更。"
                )
            if session_id:
                session_state = self._state_after_plan(
                    session_state, context, plan_id, tool_trace
                )
                self._save_history(
                    db,
                    user_id,
                    session_id,
                    [
                        {"role": "user", "content": clean_message},
                        {"role": "assistant", "content": final_message},
                    ],
                    session_state,
                )

            latency_ms = int((time.monotonic() - started) * 1000)
            self._record_usage(
                db, user_id, model, total_prompt, total_completion, latency_ms, "success"
            )
            return {
                "plan_id": plan_id,
                "message": final_message,
                "actions": context.actions,
                "configured": True,
                "usage": {
                    "model": model,
                    "prompt_tokens": total_prompt,
                    "completion_tokens": total_completion,
                    "latency_ms": latency_ms,
                },
                "budget": self._budget_info(db),
            }
        except ProviderError as error:
            latency_ms = int((time.monotonic() - started) * 1000)
            try:
                self._record_usage(
                    db, user_id, model, 0, 0, latency_ms, "error", error.code
                )
            except Exception:
                pass
            raise AgentError(502, error.code, f"AI 请求失败：{error.detail}")
        finally:
            self._semaphore.release()

    def _budget_info(self, db: Session) -> dict:
        budget = self.ai_monthly_budget(db)
        if budget <= 0:
            return {"enabled": False}
        return {
            "enabled": True,
            "remaining_usd": round(max(0.0, budget - self.spent_this_month(db)), 4),
        }


def _render_snapshot(snapshot: List[dict]) -> str:
    lines = []
    for event in snapshot[: settings.ai_max_snapshot_events]:
        try:
            row = {
                "id": event.get("id"),
                "event": event.get("event"),
                "date": event.get("date"),
                "time": event.get("time"),
                "isDeadline": event.get("isDeadline"),
                "isRecurring": event.get("isRecurring"),
                "isCompleted": event.get("isCompleted"),
            }
            # Only present on series with per-day exceptions, so most rows stay small.
            for key in ("isLongTerm", "occurrenceOverrides", "skippedDates"):
                if event.get(key):
                    row[key] = event.get(key)
            lines.append(_dump(row))
        except Exception:
            continue
    return "\n".join(lines)


def _dump(value) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, default=str)
