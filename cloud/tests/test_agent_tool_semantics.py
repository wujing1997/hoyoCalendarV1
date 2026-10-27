"""Deterministic audit coverage for the four Agent calendar tools."""

import json
import uuid
from copy import deepcopy
from datetime import datetime, timezone

from .helpers import auth_headers, make_user


TODAY = "2026-08-20"


def _context(snapshot=None, pending=None):
    from app.modules.agent.service import PlanningContext

    return PlanningContext(snapshot or [], pending or [])


def _listed_context(event):
    from app.modules.agent.service import PlanningContext

    context = PlanningContext([event], today=TODAY)
    result = context.execute("list_events", {"keyword": event["event"]})
    assert result["success"] is True
    return context


def test_list_events_single_local_date_filters_instead_of_returning_all():
    context = _context([
        {"id": "midnight", "event": "零点", "date": "2026-08-21", "time": "00:00"},
        {"id": "late", "event": "深夜", "date": "2026-08-21", "time": "23:59"},
        {"id": "next", "event": "次日", "date": "2026-08-22", "time": "00:00"},
        {
            "id": "completed", "event": "跨日完成", "date": "2026-08-20",
            "time": "23:59", "isCompleted": True, "completedDate": "2026-08-21",
        },
    ])

    result = context.execute("list_events", {"date": "2026-08-21"})

    assert result["success"] is True
    assert result["count"] == 3
    assert {event["id"] for event in result["events"]} == {
        "midnight", "late", "completed",
    }
    assert all(event["storage_status"] == "saved_event" for event in result["events"])


def test_list_events_inclusive_range_combines_with_keyword_and_has_empty_result():
    context = _context([
        {"id": "before", "event": "项目会", "date": "2026-08-19"},
        {"id": "start", "event": "项目会", "date": "2026-08-20"},
        {"id": "end", "event": "项目复盘", "date": "2026-08-22"},
        {"id": "other", "event": "个人安排", "date": "2026-08-21"},
        {"id": "after", "event": "项目会", "date": "2026-08-23"},
    ])

    result = context.execute("list_events", {
        "keyword": "项目", "start_date": "2026-08-20", "end_date": "2026-08-22",
    })
    empty = context.execute("list_events", {"date": "2026-08-24"})

    assert [event["id"] for event in result["events"]] == ["start", "end"]
    assert empty == {"success": True, "count": 0, "events": [], "truncated": False}


def test_list_events_blank_dates_mean_unfiltered_and_bad_windows_are_errors():
    context = _context([
        {"id": "a", "event": "A", "date": "2026-08-20"},
        {"id": "b", "event": "B", "date": "2026-08-21"},
    ])

    assert context.execute("list_events", {"date": ""})["count"] == 2
    assert context.execute("list_events", {})["count"] == 2
    for args in (
        {"date": "2026-02-30"},
        {"start_date": "2026-08-20"},
        {"start_date": "2026-08-22", "end_date": "2026-08-20"},
        {"date": "2026-08-20", "start_date": "2026-08-20", "end_date": "2026-08-21"},
    ):
        result = context.execute("list_events", args)
        assert result["success"] is False
        assert result.get("events") is None


def test_list_events_reports_when_result_is_capped():
    context = _context([
        {"id": f"event-{index}", "event": "批量", "date": "2026-08-21"}
        for index in range(101)
    ])

    result = context.execute("list_events", {"date": "2026-08-21"})

    assert result["count"] == 101
    assert len(result["events"]) == 100
    assert result["truncated"] is True


def test_list_events_matches_deadline_recurring_and_long_term_display_days():
    context = _context([
        {
            "id": "deadline", "event": "截止任务", "date": "2026-08-20",
            "isDeadline": True, "startDate": "2026-08-20", "deadlineDate": "2026-08-22",
        },
        {
            "id": "weekly", "event": "周会", "date": "2026-08-01",
            "isRecurring": True, "startDate": "2026-08-01", "endDate": "2026-08-31",
            "recurringType": "weekly", "recurringDays": [5],
        },
        {
            "id": "monthly", "event": "月报", "date": "2026-01-31",
            "isRecurring": True, "startDate": "2026-01-31", "endDate": "2026-12-31",
            "recurringType": "monthly", "recurringMonthDays": [31],
        },
        {
            "id": "long", "event": "长期", "date": "2026-08-20",
            "isLongTerm": True, "startDate": "2026-08-20",
        },
    ])

    assert {event["id"] for event in context.execute(
        "list_events", {"date": "2026-08-21"},
    )["events"]} == {"deadline", "weekly", "long"}
    assert {event["id"] for event in context.execute(
        "list_events", {"start_date": "2026-09-01", "end_date": "2026-10-31"},
        )["events"]} == {"deadline", "monthly", "long"}


def test_list_events_marks_pending_drafts_without_treating_them_as_saved():
    context = _context(
        [{"id": "saved", "event": "已保存", "date": "2026-08-21"}],
        [{
            "draft_id": "draft-1", "status": "pending_approval",
            "event": {"event": "待审批", "date": "2026-08-21"},
        }],
    )

    result = context.execute("list_events", {"date": "2026-08-21"})
    statuses = {event["id"]: event["storage_status"] for event in result["events"]}

    assert statuses == {
        "saved": "saved_event",
        "draft-1": "pending_approval_not_saved",
    }


def test_create_event_rejects_values_the_client_would_silently_normalize():
    invalid_cases = (
        ({"event": "", "date": "2026-08-21"}, "标题"),
        ({"event": "x", "date": "2026-02-30"}, "日期"),
        ({"event": "x", "date": "2026-08-21", "time": "24:00"}, "时间"),
        ({"event": "x", "date": "2026-08-21", "urgency": "urgent"}, "urgency"),
        ({
            "event": "x", "date": "2026-08-21", "isDeadline": True,
            "isRecurring": True,
        }, "不能同时"),
        ({
            "event": "x", "date": "2026-08-21", "isRecurring": True,
            "recurringType": "weekly", "recurringDays": [],
        }, "recurringDays"),
        ({
            "event": "x", "date": "2026-08-21", "targetDurationMinutes": 0,
        }, "正整数"),
    )
    for args, message in invalid_cases:
        context = _context()
        result = context.execute("create_event", args)
        assert result["success"] is False
        assert message in result["message"]
        assert context.actions == []


def test_create_deadline_action_uses_same_start_date_the_client_will_store():
    context = _context()
    result = context.execute("create_event", {
        "event": "交付", "date": "2026-08-30", "isDeadline": True,
        "startDate": "2026-08-21", "deadlineDate": "2026-08-30",
    })

    assert result["success"] is True
    assert result["event"]["date"] == "2026-08-21"
    assert context.actions[0]["event"]["date"] == "2026-08-21"


def test_update_event_schema_and_executor_validate_same_fields():
    from app.modules.agent.service import TOOL_DEFINITIONS

    properties = TOOL_DEFINITIONS["update_event"]["function"]["parameters"]["properties"]
    assert properties["urgency"]["enum"] == ["normal", "high"]
    context = _context([{
        "id": "deadline", "event": "旧标题", "date": "2026-08-20",
        "startDate": "2026-08-20", "deadlineDate": "2026-08-30", "isDeadline": True,
    }])
    assert context.execute("list_events", {"keyword": "旧标题"})["success"] is True

    empty = context.execute("update_event", {"id": "deadline"})
    bad_date = context.execute("update_event", {"id": "deadline", "date": "2026-02-30"})
    bad_time = context.execute("update_event", {"id": "deadline", "time": "25:10"})
    bad_urgency = context.execute("update_event", {"id": "deadline", "urgency": "urgent"})
    valid = context.execute("update_event", {
        "id": "deadline", "date": "2026-08-22", "urgency": "high",
    })

    assert all(not result["success"] for result in (empty, bad_date, bad_time, bad_urgency))
    assert valid["success"] is True
    assert context.actions[0]["type"] == "update"
    assert context.actions[0]["id"] == "deadline"
    assert context.actions[0]["updates"] == {
        "date": "2026-08-22", "startDate": "2026-08-22", "urgency": "high",
    }
    assert context.actions[0]["scope"] == "future"


def test_update_and_delete_pending_draft_never_emit_saved_event_actions():
    context = _context(pending=[{
        "draft_id": "draft-1", "status": "pending_approval",
        "event": {"event": "待审批", "date": "2026-08-21"},
    }])

    updated = context.execute("update_event", {"id": "draft-1", "event": "新标题"})
    assert updated["success"] is True
    assert context.actions[0]["type"] == "create"
    assert context.actions[0]["draft_id"] == "draft-1"
    assert "id" not in context.actions[0]["event"]

    deleted = context.execute("delete_event", {"id": "draft-1"})
    assert deleted == {
        "success": True, "cancelled_pending_draft": True, "draft_id": "draft-1",
    }
    assert context.actions == []


def test_completed_deadline_matches_completion_day_not_old_active_span():
    context = _context([{
        "id": "done-deadline", "event": "已完成截止任务", "date": "2026-08-20",
        "isDeadline": True, "startDate": "2026-08-20", "deadlineDate": "2026-08-25",
        "isDeadlineCompleted": True, "deadlineCompletedDate": "2026-08-22",
    }])

    assert context.execute("list_events", {"date": "2026-08-21"})["events"] == []
    assert context.execute("list_events", {"date": "2026-08-22"})["count"] == 1


def test_agent_request_date_is_real_iso_date_and_beijing_fallback_crosses_utc_day(client):
    from app.modules.agent.router import _beijing_today

    assert _beijing_today(datetime(2026, 8, 20, 15, 59, tzinfo=timezone.utc)) == "2026-08-20"
    assert _beijing_today(datetime(2026, 8, 20, 16, 0, tzinfo=timezone.utc)) == "2026-08-21"

    user = make_user(client)
    response = client["api"].post(
        "/api/v1/agent/plan",
        json={"message": "查询", "date": "2026-02-30"},
        headers=auth_headers(user["access_token"]),
    )
    assert response.status_code == 422


def test_same_session_id_cannot_cross_user_pending_draft_boundary(client):
    from app.database import get_session
    from app.modules.agent.provider import ChatResult, ToolCall
    from app.modules.agent.router import _agent_service
    from app.modules.agent.service import AgentService

    user_a = make_user(client, email="tool-iso-a@example.com")
    user_b = make_user(client, email="tool-iso-b@example.com")
    me_a = client["api"].get(
        "/api/v1/me", headers=auth_headers(user_a["access_token"]),
    ).json()
    session_id = "same-tool-session"
    db = get_session()
    AgentService._save_history(db, me_a["id"], session_id, [], {
        "pending_drafts": [{
            "draft_id": "private-draft", "plan_id": str(uuid.uuid4()),
            "status": "pending_approval",
            "event": {"event": "A draft", "date": "2026-08-21"},
        }],
    })
    db.close()

    class CaptureListProvider:
        def __init__(self):
            self.results = []

        def complete(self, messages, tools, model):
            if messages[-1].get("role") == "tool":
                self.results.append(json.loads(messages[-1]["content"]))
                return ChatResult(content="查询完成。")
            return ChatResult(content="", tool_calls=[ToolCall(
                str(uuid.uuid4()), "list_events", {"date": "2026-08-21"},
            )])

    provider = CaptureListProvider()
    _agent_service.provider_override = provider
    for user, event_id in ((user_a, "saved-a"), (user_b, "saved-b")):
        response = client["api"].post(
            "/api/v1/agent/plan",
            json={
                "message": "查询当天", "session_id": session_id,
                "snapshot": [{"id": event_id, "event": event_id, "date": "2026-08-21"}],
            },
            headers=auth_headers(user["access_token"]),
        )
        assert response.status_code == 200, response.text

    assert {event["id"] for event in provider.results[0]["events"]} == {
        "saved-a", "private-draft",
    }
    assert {event["id"] for event in provider.results[1]["events"]} == {"saved-b"}


def test_model_schema_exposes_scope_and_all_editable_task_fields():
    from app.modules.agent.service import TOOL_DEFINITIONS
    from app.schemas import AgentAction

    update = TOOL_DEFINITIONS["update_event"]["function"]["parameters"]["properties"]
    delete = TOOL_DEFINITIONS["delete_event"]["function"]["parameters"]["properties"]
    assert update["scope"]["enum"] == ["future", "all", "past", "single"]
    assert delete["scope"]["enum"] == ["future", "all", "past", "single"]
    assert delete["scope"]["default"] == "future"
    for field in (
        "event", "date", "time", "location", "note", "urgency", "calendar",
        "event_type", "isDeadline", "startDate", "deadlineDate", "isRecurring",
        "recurringType", "recurringDays", "recurringMonthDays", "endDate",
        "isLongTerm", "targetDurationMinutes", "effective_date",
    ):
        assert field in update
    parsed = AgentAction.model_validate({
        "type": "delete", "id": "event-id", "scope": "future",
        "effective_date": TODAY,
    })
    assert parsed.scope == "future"


def test_saved_event_update_and_delete_require_prior_list():
    from app.modules.agent.service import PlanningContext

    event = {"id": 42, "event": "健身", "date": "2026-08-01", "isRecurring": True}
    context = PlanningContext([event], today=TODAY)
    update = context.execute("update_event", {"id": 42, "event": "晨练"})
    delete = context.execute("delete_event", {"id": 42})
    assert update["success"] is delete["success"] is False
    assert "list_events" in update["message"]
    assert context.actions == []


def test_default_scope_is_future_and_uses_request_today():
    context = _listed_context({
        "id": "series-id", "event": "健身", "date": "2026-08-01",
        "startDate": "2026-08-01", "isRecurring": True,
        "recurringType": "daily", "endDate": "2026-12-31",
    })
    result = context.execute("delete_event", {"id": "series-id"})
    assert result["success"] is True
    assert context.actions == [{
        "type": "delete", "id": "series-id",
        "scope": "future", "effective_date": TODAY,
    }]


def test_uncompleted_overdue_deadline_still_has_a_future_side():
    context = _listed_context({
        "id": "deadline-id", "event": "逾期报告", "date": "2026-08-01",
        "startDate": "2026-08-01", "isDeadline": True,
        "deadlineDate": "2026-08-10", "isDeadlineCompleted": False,
    })
    result = context.execute("delete_event", {"id": "deadline-id"})
    assert result["success"] is True
    assert context.actions[0]["effective_date"] == TODAY


def test_historical_one_off_is_blocked_by_future_but_explicit_all_is_allowed():
    context = _listed_context({"id": "old", "event": "旧会议", "date": "2026-08-01"})
    blocked = context.execute("update_event", {"id": "old", "event": "不应修改"})
    assert blocked["success"] is False
    assert context.actions == []
    allowed = context.execute("update_event", {
        "id": "old", "event": "历史更正", "scope": "all",
    })
    assert allowed["success"] is True
    assert context.actions[0]["scope"] == "all"


def test_update_supports_type_conversion_and_full_reasonable_fields():
    context = _listed_context({
        "id": "task", "event": "旧任务", "date": "2026-08-21",
        "isLongTerm": True, "startDate": "2026-08-21",
    })
    result = context.execute("update_event", {
        "id": "task", "event": "月度检查", "time": "09:30", "location": "办公室",
        "note": "带报告", "urgency": "high", "calendar": "工作",
        "event_type": "recurring", "recurringType": "monthly",
        "recurringMonthDays": [1, 15, 15, 32], "endDate": None,
        "targetDurationMinutes": 45,
    })
    assert result["success"] is True
    action = context.actions[0]
    assert action["scope"] == "future"
    assert action["updates"]["isRecurring"] is True
    assert action["updates"]["isLongTerm"] is False
    assert action["updates"]["recurringMonthDays"] == [1, 15]
    assert action["updates"]["endDate"] is None
    assert action["updates"]["targetDurationSeconds"] == 2700
    assert action["updates"]["calendar"] == "工作"


def test_pending_draft_full_update_remains_a_create_draft():
    from app.modules.agent.service import PlanningContext

    context = PlanningContext([], pending_drafts=[{
        "draft_id": "draft-scope", "event": {"event": "草案", "date": "2026-08-21"},
    }], today=TODAY)
    result = context.execute("update_event", {
        "id": "draft-scope", "event_type": "deadline",
        "startDate": "2026-08-21", "deadlineDate": "2026-08-31",
    })
    assert result["success"] is True
    assert context.actions[0]["type"] == "create"
    assert context.actions[0]["draft_id"] == "draft-scope"
    assert context.actions[0]["event"]["isDeadline"] is True


DINNER_OPTIONS = [
    {"label": "不设时间", "event": {"event": "吃晚饭", "date": TODAY}},
    {"label": "今天 18:30", "event": {"event": "吃晚饭", "date": TODAY, "time": "18:30"}},
    {"label": "每天 18:30 重复", "event": {
        "event": "吃晚饭", "date": TODAY, "time": "18:30",
        "isRecurring": True, "recurringType": "daily",
    }},
]


def test_propose_event_options_schema_reuses_create_event_fields():
    from app.modules.agent.service import TOOL_DEFINITIONS, select_tools
    from app.schemas import AgentAction

    create = TOOL_DEFINITIONS["create_event"]["function"]["parameters"]["properties"]
    params = TOOL_DEFINITIONS["propose_event_options"]["function"]["parameters"]
    options = params["properties"]["options"]
    assert params["required"] == ["options"]
    assert (options["minItems"], options["maxItems"]) == (2, 4)
    assert options["items"]["properties"]["event"]["properties"] == create
    assert options["items"]["required"] == ["label", "event"]
    assert "propose_event_options" in {
        tool["function"]["name"] for tool in select_tools("提醒我吃晚饭")
    }
    parsed = AgentAction.model_validate({
        "type": "create", "draft_id": "draft-1", "event": {"event": "x", "date": TODAY},
        "choice_group_id": "choice-1", "option_label": "不设时间",
    })
    assert parsed.choice_group_id == "choice-1"


def test_propose_event_options_emits_one_create_draft_per_option_in_one_group():
    context = _context()

    result = context.execute("propose_event_options", {"options": DINNER_OPTIONS})

    assert result["success"] is True
    assert [action["type"] for action in context.actions] == ["create"] * 3
    group_ids = {action["choice_group_id"] for action in context.actions}
    assert group_ids == {result["choice_group_id"]}
    assert [action["option_label"] for action in context.actions] == [
        "不设时间", "今天 18:30", "每天 18:30 重复",
    ]
    assert context.actions[0]["event"]["time"] == ""
    assert context.actions[1]["event"]["time"] == "18:30"
    assert context.actions[2]["event"]["isRecurring"] is True
    assert context.actions[2]["event"]["recurringType"] == "daily"
    for action in context.actions:
        assert not any(key.startswith("_") for key in action["event"])
    drafts = context.pending_drafts()
    assert {draft["choice_group_id"] for draft in drafts} == group_ids
    listed = context.execute("list_events", {"keyword": "晚饭"})
    assert all(item["choice_group_id"] in group_ids for item in listed["events"])
    assert all("_choice_group_id" not in item for item in listed["events"])


def test_propose_event_options_is_atomic_and_bounds_option_count():
    context = _context()
    bad = deepcopy(DINNER_OPTIONS)
    bad[1]["event"]["time"] = "25:00"

    for args in (
        {"options": bad},
        {"options": DINNER_OPTIONS[:1]},
        {"options": DINNER_OPTIONS * 2},
        {"options": [{"label": "", "event": {"event": "x", "date": TODAY}}] * 2},
        {"options": [{"label": "a"}, {"label": "b"}]},
    ):
        result = context.execute("propose_event_options", args)
        assert result["success"] is False, args

    assert context.actions == []
    assert context.pending_drafts() == []


def test_updating_and_reloading_an_option_draft_keeps_its_choice_group():
    from app.modules.agent.service import PlanningContext

    first = _context()
    first.execute("propose_event_options", {"options": DINNER_OPTIONS})
    drafts = first.pending_drafts()

    context = PlanningContext([], pending_drafts=drafts, today=TODAY)
    target = drafts[1]["draft_id"]
    result = context.execute("update_event", {"id": target, "time": "19:00"})

    assert result["success"] is True
    action = context.actions[0]
    assert action["draft_id"] == target
    assert action["event"]["time"] == "19:00"
    assert action["choice_group_id"] == drafts[1]["choice_group_id"]
    assert action["option_label"] == "今天 18:30"


def test_approving_one_option_receipt_drops_its_sibling_drafts():
    from app.modules.agent.service import AgentService

    context = _context()
    context.execute("propose_event_options", {"options": DINNER_OPTIONS})
    plan_id = str(uuid.uuid4())
    state = AgentService._state_after_plan({}, context, plan_id, [])
    other = {"draft_id": "unrelated", "plan_id": plan_id, "event": {"event": "其他"}}
    state["pending_drafts"].append(other)
    chosen = state["pending_drafts"][2]

    next_state = AgentService._apply_receipts(state, [{
        "plan_id": plan_id, "draft_id": chosen["draft_id"],
        "status": "approved", "event_id": "saved-uuid",
    }])

    assert next_state["pending_drafts"] == [other]
    assert next_state["recent_reference"]["event_id"] == "saved-uuid"


WORK = {
    "id": "work", "event": "去上班", "date": "2026-08-01", "time": "18:00",
    "isRecurring": True, "recurringType": "daily", "startDate": "2026-08-01",
}


def test_single_update_overrides_one_occurrence_only():
    context = _listed_context(deepcopy(WORK))

    result = context.execute("update_event", {
        "id": "work", "time": "19:00", "scope": "single", "effective_date": "2026-08-21",
    })

    assert result["success"] is True
    assert context.actions == [{
        "type": "update", "id": "work", "updates": {"time": "19:00"},
        "scope": "single", "effective_date": "2026-08-21",
    }]
    event = context.events[0]
    assert event["time"] == "18:00"
    assert event["occurrenceOverrides"] == {"2026-08-21": {"time": "19:00"}}


def test_single_update_rejects_series_fields_deadlines_and_unscheduled_days():
    weekly = {**WORK, "id": "weekly", "event": "周会", "recurringType": "weekly", "recurringDays": [1]}
    deadline = {"id": "ddl", "event": "报告", "date": TODAY, "isDeadline": True,
                "startDate": TODAY, "deadlineDate": "2026-08-31"}
    from app.modules.agent.service import PlanningContext

    context = PlanningContext([deepcopy(WORK), weekly, deadline], today=TODAY)
    context.execute("list_events", {})

    for args in (
        {"id": "work", "recurringType": "weekly", "recurringDays": [1]},
        {"id": "work", "date": "2026-08-22"},
        {"id": "weekly", "time": "10:00", "effective_date": "2026-08-20"},  # 周四
        {"id": "work", "time": "19:00", "effective_date": "2026-07-31"},
        {"id": "ddl", "time": "10:00"},
    ):
        result = context.execute("update_event", {"scope": "single", "effective_date": TODAY, **args})
        assert result["success"] is False, args
    assert context.actions == []


def test_single_delete_skips_one_day_and_list_events_honours_it():
    context = _listed_context(deepcopy(WORK))

    result = context.execute("delete_event", {
        "id": "work", "scope": "single", "effective_date": "2026-08-21",
    })
    again = context.execute("delete_event", {
        "id": "work", "scope": "single", "effective_date": "2026-08-21",
    })

    assert result["success"] is True
    assert again["success"] is False
    assert context.actions == [{
        "type": "delete", "id": "work", "scope": "single", "effective_date": "2026-08-21",
    }]
    assert context.execute("list_events", {"date": "2026-08-21"})["count"] == 0
    assert context.execute("list_events", {"date": "2026-08-22"})["count"] == 1
    assert context.execute("list_events", {
        "start_date": "2026-08-21", "end_date": "2026-08-21",
    })["count"] == 0


def test_single_update_on_a_skipped_day_restores_it():
    skipped = {**deepcopy(WORK), "skippedDates": ["2026-08-21"]}
    context = _listed_context(skipped)

    result = context.execute("update_event", {
        "id": "work", "time": "20:00", "scope": "single", "effective_date": "2026-08-21",
    })

    assert result["success"] is True
    assert context.events[0]["skippedDates"] == []
    assert context.execute("list_events", {"date": "2026-08-21"})["count"] == 1


def test_single_scope_on_one_off_event_applies_only_on_its_own_day():
    one_off = {"id": "dinner", "event": "聚餐", "date": "2026-08-21", "time": "18:00"}
    context = _listed_context(one_off)

    wrong_day = context.execute("update_event", {
        "id": "dinner", "time": "19:00", "scope": "single", "effective_date": "2026-08-22",
    })
    right_day = context.execute("update_event", {
        "id": "dinner", "time": "19:00", "scope": "single", "effective_date": "2026-08-21",
    })

    assert wrong_day["success"] is False
    assert right_day["success"] is True
    assert context.actions[0]["scope"] == "single"


def test_snapshot_exposes_occurrence_exceptions_to_the_model():
    from app.modules.agent.service import _render_snapshot

    rendered = _render_snapshot([
        {**WORK, "occurrenceOverrides": {"2026-08-21": {"time": "19:00"}},
         "skippedDates": ["2026-08-22"]},
        {"id": "plain", "event": "普通", "date": TODAY},
    ]).splitlines()

    assert json.loads(rendered[0])["occurrenceOverrides"] == {"2026-08-21": {"time": "19:00"}}
    assert json.loads(rendered[0])["skippedDates"] == ["2026-08-22"]
    assert "skippedDates" not in json.loads(rendered[1])
