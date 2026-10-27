"""Agent gateway acceptance tests: action-plan only, no body retention,
schema validation, budget circuit breaker, admin master switch."""

import uuid

from .helpers import auth_headers, make_user


def _plan(client, user, message="创建明天的项目会议", snapshot=None,
          session_id=None, receipts=None, continue_planning=False):
    payload = {"message": message}
    if snapshot is not None:
        payload["snapshot"] = snapshot
    if session_id is not None:
        payload["session_id"] = session_id
    if receipts is not None:
        payload["receipts"] = receipts
    if continue_planning:
        payload["continue_planning"] = True
    return client["api"].post(
        "/api/v1/agent/plan",
        json=payload,
        headers=auth_headers(user["access_token"]),
    )


def _set_agent_service_provider(plan):
    from app.modules.agent.router import _agent_service
    from app.modules.agent.provider import FakeProvider

    _agent_service.provider_override = FakeProvider(plan=plan)
    return _agent_service


def test_plan_returns_structured_actions(client):
    _set_agent_service_provider([
        {"tool_calls": [{"name": "create_event", "arguments": {"event": "云会议", "date": "2026-08-10", "time": "14:00"}}]},
        {"content": "已规划 1 项日程变更。"},
    ])
    user = make_user(client)
    resp = _plan(client, user)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["configured"] is True
    assert len(body["actions"]) == 1
    action = body["actions"][0]
    assert action["type"] == "create"
    assert action["event"]["event"] == "云会议"


def test_agent_does_not_write_events(client):
    _set_agent_service_provider([
        {"tool_calls": [{"name": "create_event", "arguments": {"event": "不应落库", "date": "2026-08-10"}}]},
        {"content": "已规划。"},
    ])
    user = make_user(client)
    _plan(client, user)
    pulled = client["api"].get("/api/v1/sync/pull", headers=auth_headers(user["access_token"]))
    assert pulled.json()["events"] == []


def test_no_body_persisted_only_metadata(client):
    _set_agent_service_provider([
        {"tool_calls": [{"name": "create_event", "arguments": {"event": "秘密任务", "date": "2026-08-10"}}]},
        {"content": "这是模型回复正文，不应留存。"},
    ])
    user = make_user(client)
    _plan(client, user, message="帮我创建秘密任务")

    from app.database import get_session
    from app import models
    from sqlalchemy import select

    db = get_session()
    rows = db.execute(select(models.AiUsage)).scalars().all()
    db.close()
    assert len(rows) == 1
    usage = rows[0]
    assert usage.prompt_tokens >= 0
    assert usage.estimated_cost_usd is not None
    # No table in the schema stores message/snapshot/reply bodies.
    assert usage.model


def test_snapshot_and_message_not_in_usage_columns(client):
    _set_agent_service_provider([{"content": "查询完成。"}])
    user = make_user(client)
    _plan(client, user, message="查看日程")
    from app.database import get_session
    from app import models
    from sqlalchemy import select

    db = get_session()
    row = db.execute(select(models.AiUsage)).scalars().first()
    db.close()
    dumped = {c.name: getattr(row, c.name) for c in models.AiUsage.__table__.columns}
    assert "查看日程" not in str(dumped)
    assert "查询完成" not in str(dumped)


def test_plan_requires_message(client):
    user = make_user(client)
    resp = client["api"].post(
        "/api/v1/agent/plan",
        json={"message": ""},
        headers=auth_headers(user["access_token"]),
    )
    assert resp.status_code == 422


def test_plan_rejects_oversized_snapshot(client):
    user = make_user(client)
    snapshot = [{"event": f"e{i}"} for i in range(501)]
    resp = client["api"].post(
        "/api/v1/agent/plan",
        json={"message": "查看", "snapshot": snapshot},
        headers=auth_headers(user["access_token"]),
    )
    assert resp.status_code == 422


def test_budget_circuit_breaker_blocks_ai_only(client):
    from app.modules.agent.router import _agent_service
    from app.modules.agent.provider import FakeProvider

    _agent_service.provider_override = FakeProvider(plan=[{"content": "ok"}])
    user = make_user(client)
    token = client["admin"]
    admin_resp = token.post("/api/v1/admin/login", json={"username": "admin", "password": "correct-horse-battery-staple"})
    admin_token = admin_resp.json()["token"]
    set_resp = token.put(
        "/api/v1/admin/settings",
        json={"ai_enabled": True, "ai_monthly_budget_usd": 0.01},
        headers=auth_headers(admin_token),
    )
    assert set_resp.status_code == 200, set_resp.text

    # seed spend beyond the tiny budget
    from app.database import get_session
    from app import models

    db = get_session()
    me = client["api"].get("/api/v1/me", headers=auth_headers(user["access_token"])).json()
    db.add(models.AiUsage(
        user_id=me["id"], model="test", prompt_tokens=1000,
        completion_tokens=1000, estimated_cost_usd=0.05, latency_ms=1,
        status="success",
    ))
    db.commit()
    db.close()

    agent_resp = _plan(client, user)
    assert agent_resp.status_code == 429

    # calendar and sync are unaffected
    assert client["api"].get("/healthz").status_code == 200
    assert client["api"].get("/api/v1/me", headers=auth_headers(user["access_token"])).status_code == 200


def test_admin_switch_disables_ai(client):
    from app.modules.agent.router import _agent_service
    from app.modules.agent.provider import FakeProvider

    _agent_service.provider_override = FakeProvider(plan=[{"content": "ok"}])
    user = make_user(client)
    admin_resp = client["admin"].post("/api/v1/admin/login", json={"username": "admin", "password": "correct-horse-battery-staple"})
    admin_token = admin_resp.json()["token"]
    set_resp = client["admin"].put(
        "/api/v1/admin/settings",
        json={"ai_enabled": False, "ai_monthly_budget_usd": 0.0},
        headers=auth_headers(admin_token),
    )
    assert set_resp.status_code == 200

    agent_resp = _plan(client, user)
    assert agent_resp.status_code == 503
    assert client["api"].get("/healthz").status_code == 200


def test_agent_requires_auth(client):
    resp = client["api"].post("/api/v1/agent/plan", json={"message": "hi"})
    assert resp.status_code == 401


def test_select_tools_injects_every_tool():
    from app.modules.agent.service import select_tools

    for message in (
        "新建日程:明天下午3点开会",
        "帮我新建日程",
        "添加日程",
        "删除日程",
        "查看明天的安排",
        "修改日程",
    ):
        names = [t["function"]["name"] for t in select_tools(message)]
        assert names == [
            "list_events", "create_event", "propose_event_options", "update_event", "delete_event",
        ], message


def test_select_tools_ignores_message_intent():
    from app.modules.agent.service import select_tools

    # Short/context-dependent phrases must not be limited to a guessed subset.
    names = [t["function"]["name"] for t in select_tools("只改这一次")]
    assert names == [
        "list_events", "create_event", "propose_event_options", "update_event", "delete_event",
    ]


def test_create_event_tool_covers_all_task_types():
    from app.modules.agent.service import PlanningContext

    context = PlanningContext([])
    normal = context.execute("create_event", {"event": "开会", "date": "2026-08-20", "time": "14:00"})
    assert normal["success"] is True
    assert normal["event"]["event"] == "开会"
    assert context.actions[0]["event"]["time"] == "14:00"

    deadline = context.execute("create_event", {
        "event": "交报告", "date": "2026-08-20",
        "isDeadline": True, "startDate": "2026-08-10", "deadlineDate": "2026-08-20",
    })
    assert deadline["event"]["isDeadline"] is True
    assert deadline["event"]["deadlineDate"] == "2026-08-20"

    weekly = context.execute("create_event", {
        "event": "健身", "date": "2026-08-20",
        "isRecurring": True, "recurringType": "weekly", "recurringDays": [3, 5],
        "endDate": "2026-12-31",
    })
    assert weekly["event"]["recurringDays"] == [3, 5]
    assert weekly["event"]["endDate"] == "2026-12-31"

    monthly = context.execute("create_event", {
        "event": "账单", "date": "2026-08-20",
        "isRecurring": True, "recurringType": "monthly", "recurringMonthDays": [1, 15],
    })
    assert monthly["event"]["recurringMonthDays"] == [1, 15]

    long_term = context.execute("create_event", {
        "event": "备考", "date": "2026-08-20", "isLongTerm": True,
        "targetDurationMinutes": 120,
    })
    assert long_term["event"]["isLongTerm"] is True
    assert long_term["event"]["targetDurationMinutes"] == 120


def test_create_event_validates_dates_and_feedback():
    from app.modules.agent.service import PlanningContext

    context = PlanningContext([])
    bad = context.execute("create_event", {"event": "x", "date": "2026/08/20"})
    assert bad["success"] is False
    assert "YYYY-MM-DD" in bad["message"]
    assert context.actions == []

    bad_deadline = context.execute("create_event", {
        "event": "x", "date": "2026-08-20",
        "isDeadline": True, "startDate": "2026-08-21", "deadlineDate": "2026-08-20",
    })
    assert bad_deadline["success"] is False
    assert "截止日期不能早于" in bad_deadline["message"]

    bad_minutes = context.execute("create_event", {
        "event": "x", "date": "2026-08-20", "targetDurationMinutes": -5,
    })
    assert bad_minutes["success"] is False


def test_plan_creates_long_term_and_monthly_actions(client):
    _set_agent_service_provider([
        {"tool_calls": [{"name": "create_event", "arguments": {
            "event": "备考", "date": "2026-08-20", "isLongTerm": True,
            "targetDurationMinutes": 90,
        }}]},
        {"content": "已规划长期任务。"},
    ])
    user = make_user(client)
    resp = _plan(client, user, message="新建日程:长期任务备考,每天专注90分钟")
    assert resp.status_code == 200, resp.text
    action = resp.json()["actions"][0]
    assert action["type"] == "create"
    assert action["event"]["isLongTerm"] is True
    assert action["event"]["targetDurationMinutes"] == 90

    _set_agent_service_provider([
        {"tool_calls": [{"name": "create_event", "arguments": {
            "event": "交房租", "date": "2026-08-20",
            "isRecurring": True, "recurringType": "monthly", "recurringMonthDays": [1, 15],
        }}]},
        {"content": "已规划每月重复。"},
    ])
    user2 = make_user(client)
    resp2 = _plan(client, user2, message="新建每月1号和15号交房租")
    assert resp2.status_code == 200, resp2.text
    event2 = resp2.json()["actions"][0]["event"]
    assert event2["recurringMonthDays"] == [1, 15]
    assert event2["recurringType"] == "monthly"


def test_agent_not_configured_without_provider(client):
    from app.modules.agent.router import _agent_service

    _agent_service.provider_override = None
    user = make_user(client)
    resp = _plan(client, user)
    assert resp.status_code == 503


def test_assistant_tool_call_arguments_serialized_as_json_string(client):
    """回归：多轮工具循环回填 assistant.tool_calls 时，arguments 必须是 JSON 字符串
    （OpenAI 线格式 / DeepSeek 严格校验），否则第 2 轮请求会被上游 400 拒绝。"""
    import json as jsonlib

    from app.modules.agent.provider import FakeProvider, ToolCall
    from app.modules.agent.router import _agent_service

    class WireCheckProvider(FakeProvider):
        def __init__(self):
            super().__init__(plan=[
                {"tool_calls": [{"name": "create_event", "arguments": {"event": "x", "date": "2026-08-10"}}]},
                {"content": "完成。"},
            ])
            self.checked = False

        def complete(self, messages, tools, model):
            for message in messages:
                if message.get("role") == "assistant" and message.get("tool_calls"):
                    for call in message["tool_calls"]:
                        arguments = call["function"]["arguments"]
                        assert isinstance(arguments, str), "tool_calls arguments 必须是 JSON 字符串"
                        jsonlib.loads(arguments)
                    self.checked = True
            return super().complete(messages, tools, model)

    _agent_service.provider_override = WireCheckProvider()
    user = make_user(client)
    resp = _plan(client, user)
    assert resp.status_code == 200
    assert _agent_service.provider_override.checked


# ---------------------------------------------------------------------------
# PostgreSQL-backed shared session (item 2): cross-worker, restart, isolation,
# history cap and TTL cleanup. These simulate the deployment where two uvicorn
# workers each hold their own AgentService but share the Postgres agent_sessions
# table, so consecutive requests with the same (user_id, session_id) keep
# adjacent context.
# ---------------------------------------------------------------------------


def test_session_persists_across_worker_instances(client):
    """History written by one AgentService is readable by another (simulated
    uvicorn worker), as both share the same Postgres table."""
    from app.database import get_session
    from app.modules.agent.service import AgentService

    user = make_user(client)
    session_id = f"sess-{user['email']}"

    # Resolve the user's real DB id the way the router does (via /me).
    me = client["api"].get("/api/v1/me", headers=auth_headers(user["access_token"])).json()
    uid = me["id"]

    # worker A saves
    db = get_session()
    AgentService._save_history(db, uid, session_id, [
        {"role": "user", "content": "第一轮"},
        {"role": "assistant", "content": "好的"},
    ])
    db.close()

    # worker B (fresh service) reads
    db = get_session()
    history = AgentService._load_history(db, uid, session_id)
    db.close()
    assert [m["content"] for m in history] == ["第一轮", "好的"]


def test_session_history_accumulates_and_caps(client):
    """Repeated writes accumulate and are truncated to AGENT_HISTORY_MESSAGES."""
    from app.database import get_session
    from app.modules.agent.service import AgentService

    user = make_user(client)
    me = client["api"].get("/api/v1/me", headers=auth_headers(user["access_token"])).json()
    uid = me["id"]
    session_id = f"sess-cap-{user['email']}"

    db = get_session()
    for i in range(12):
        AgentService._save_history(db, uid, session_id, [
            {"role": "user", "content": f"u{i}"},
            {"role": "assistant", "content": f"a{i}"},
        ])
    history = AgentService._load_history(db, uid, session_id)
    db.close()
    assert len(history) == 8  # AGENT_HISTORY_MESSAGES default
    assert history[0]["content"] == "u8"
    assert history[-1]["content"] == "a11"


def test_session_isolation_between_users(client):
    """Two users using the same session_id string must not share history."""
    from app.database import get_session
    from app.modules.agent.service import AgentService

    ua = make_user(client, email="iso-a@example.com")
    ub = make_user(client, email="iso-b@example.com")
    sid = "shared-session-string"

    me_a = client["api"].get("/api/v1/me", headers=auth_headers(ua["access_token"])).json()
    me_b = client["api"].get("/api/v1/me", headers=auth_headers(ub["access_token"])).json()

    db = get_session()
    AgentService._save_history(db, me_a["id"], sid, [
        {"role": "user", "content": "A 的私密内容"},
        {"role": "assistant", "content": "r1"},
    ])
    hist_b = AgentService._load_history(db, me_b["id"], sid)
    db.close()
    assert hist_b == []  # user B must not see A's history


def test_session_ttl_cleanup_removes_expired(client):
    """Expired sessions (updated_at older than TTL) are removed by cleanup."""
    from app.database import get_session
    from app.modules.agent.service import AgentService
    from app.config import settings

    user = make_user(client)
    me = client["api"].get("/api/v1/me", headers=auth_headers(user["access_token"])).json()
    uid = me["id"]

    db = get_session()
    AgentService._save_history(db, uid, "fresh-sess", [{"role": "user", "content": "x"}])
    AgentService._save_history(db, uid, "stale-sess", [{"role": "user", "content": "y"}])

    # age the stale session past TTL
    from datetime import datetime as _dt, timedelta as _td, timezone as _tz
    from app import models
    from sqlalchemy import update as sa_update
    db.execute(
        sa_update(models.AgentSession)
        .where(models.AgentSession.session_id == "stale-sess")
        .values(updated_at=_dt.now(_tz.utc) - _td(days=settings.agent_session_ttl_days + 1))
    )
    db.commit()

    AgentService._cleanup_expired_sessions(db)
    remaining = AgentService._load_history(db, uid, "stale-sess")
    fresh = AgentService._load_history(db, uid, "fresh-sess")
    db.close()
    assert remaining == []
    assert fresh != []


def test_concurrent_first_session_writes_are_serialized(client):
    """Two workers creating the same session must not race or lose a turn."""
    from concurrent.futures import ThreadPoolExecutor

    from app.database import get_session
    from app.modules.agent.service import AgentService

    user = make_user(client)
    me = client["api"].get(
        "/api/v1/me", headers=auth_headers(user["access_token"])
    ).json()
    uid = me["id"]
    session_id = "concurrent-first-write"

    def write_turn(index):
        db = get_session()
        try:
            AgentService._save_history(db, uid, session_id, [
                {"role": "user", "content": f"u{index}"},
                {"role": "assistant", "content": f"a{index}"},
            ])
        finally:
            db.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        list(executor.map(write_turn, (1, 2)))

    db = get_session()
    try:
        contents = {
            item["content"]
            for item in AgentService._load_history(db, uid, session_id)
        }
    finally:
        db.close()
    assert contents == {"u1", "a1", "u2", "a2"}


def test_numeric_reply_keeps_exact_assistant_choice_context(client):
    """截图回归：助手给出两个选项后，用户仅回复 2 也保留语义上下文。"""
    from app.modules.agent.provider import ChatResult
    from app.modules.agent.router import _agent_service

    class ChoiceProvider:
        def __init__(self):
            self.calls = []

        def complete(self, messages, tools, model):
            from copy import deepcopy
            self.calls.append(deepcopy(messages))
            if messages[-1]["content"] == "2":
                return ChatResult(content="好的，按第二个方案继续。")
            return ChatResult(content="请选择：1. 本周五；2. 下周一。")

    provider = ChoiceProvider()
    _agent_service.provider_override = provider
    user = make_user(client)
    sid = "screenshot-choice-session"
    first = _plan(client, user, "帮我安排这项任务", session_id=sid)
    second = _plan(client, user, "2", session_id=sid)

    assert first.status_code == second.status_code == 200
    second_messages = provider.calls[1]
    assert second_messages[-3:] == [
        {"role": "user", "content": "帮我安排这项任务"},
        {"role": "assistant", "content": "请选择：1. 本周五；2. 下周一。"},
        {"role": "user", "content": "2"},
    ]
    assert second.json()["message"] == "好的，按第二个方案继续。"


def test_pending_draft_pronoun_update_stays_unsaved_and_keeps_tool_context(client):
    from app.database import get_session
    from app import models
    from app.modules.agent.provider import ChatResult, ToolCall
    from app.modules.agent.router import _agent_service
    from sqlalchemy import select

    class DraftProvider:
        def __init__(self):
            self.request = 0
            self.draft_id = None
            self.second_messages = None

        def complete(self, messages, tools, model):
            has_tool_result = messages[-1].get("role") == "tool"
            if not has_tool_result:
                self.request += 1
                if self.request == 1:
                    return ChatResult(content="", tool_calls=[ToolCall(
                        "create-1", "create_event",
                        {"event": "项目会议", "date": "2026-08-21"},
                    )])
                self.second_messages = messages
                system = messages[0]["content"]
                marker = '"draft_id": "'
                self.draft_id = system.split(marker, 1)[1].split('"', 1)[0]
                return ChatResult(content="", tool_calls=[ToolCall(
                    "update-1", "update_event",
                    {"id": self.draft_id, "date": "2026-08-22"},
                )])
            return ChatResult(content="草案已调整，仍待审批。")

    provider = DraftProvider()
    _agent_service.provider_override = provider
    user = make_user(client)
    sid = "pending-pronoun-session"
    first = _plan(client, user, "创建明天的项目会议", session_id=sid)
    second = _plan(client, user, "把刚才那个改到后天", session_id=sid)

    assert first.status_code == second.status_code == 200
    first_action = first.json()["actions"][0]
    second_action = second.json()["actions"][0]
    assert second_action["type"] == "create"
    assert second_action["draft_id"] == first_action["draft_id"] == provider.draft_id
    assert second_action["event"]["date"] == "2026-08-22"
    assert "pending_approval_not_saved" in provider.second_messages[0]["content"]

    me = client["api"].get(
        "/api/v1/me", headers=auth_headers(user["access_token"])
    ).json()
    db = get_session()
    try:
        assert db.execute(select(models.CalendarEvent)).scalars().all() == []
        row = db.execute(select(models.AgentSession).where(
            models.AgentSession.user_id == me["id"],
            models.AgentSession.session_id == sid,
        )).scalar_one()
        assert row.state["pending_drafts"][0]["draft_id"] == provider.draft_id
        assert row.state["pending_drafts"][0]["event"]["date"] == "2026-08-22"
        assert [trace["name"] for trace in row.state["tool_traces"]] == [
            "create_event", "update_event",
        ]
    finally:
        db.close()


def test_draft_receipts_require_matching_plan_and_update_reference(client):
    from app.database import get_session
    from app import models
    from app.modules.agent.router import _agent_service
    from sqlalchemy import select

    user = make_user(client)
    sid = "receipt-session"
    _set_agent_service_provider([
        {"tool_calls": [{"name": "create_event", "arguments": {
            "event": "待审批", "date": "2026-08-21",
        }}]},
        {"content": "待审批。"},
    ])
    created = _plan(client, user, "创建待审批日程", session_id=sid).json()
    draft_id = created["actions"][0]["draft_id"]

    class ForbiddenProvider:
        def complete(self, messages, tools, model):
            raise AssertionError("receipt-only 请求不得调用模型")

    _agent_service.provider_override = ForbiddenProvider()
    stale = _plan(client, user, "", session_id=sid, receipts=[{
        "plan_id": str(uuid.uuid4()), "draft_id": draft_id,
        "status": "rejected",
    }])
    assert stale.status_code == 200
    assert stale.json()["actions"] == []
    assert stale.json()["usage"]["model"] == "receipt-only"

    approved = _plan(client, user, "已批准", session_id=sid, receipts=[{
        "plan_id": created["plan_id"], "draft_id": draft_id,
        "status": "approved", "event_id": "saved-event-uuid",
    }])
    assert approved.status_code == 200

    duplicate = _plan(client, user, "", session_id=sid, receipts=[{
        "plan_id": created["plan_id"], "draft_id": draft_id,
        "status": "approved", "event_id": "saved-event-uuid",
    }])
    assert duplicate.status_code == 200

    me = client["api"].get(
        "/api/v1/me", headers=auth_headers(user["access_token"])
    ).json()
    db = get_session()
    try:
        row = db.execute(select(models.AgentSession).where(
            models.AgentSession.user_id == me["id"],
            models.AgentSession.session_id == sid,
        )).scalar_one()
        usage_count = len(db.execute(select(models.AiUsage).where(
            models.AiUsage.user_id == me["id"],
        )).scalars().all())
    finally:
        db.close()
    state = row.state
    assert len(row.messages) == 2
    assert usage_count == 1
    assert state["pending_drafts"] == []
    assert state["recent_reference"]["storage_status"] == "saved_event"
    assert state["recent_reference"]["event_id"] == "saved-event-uuid"


def test_receipt_only_rejected_and_failed_are_deterministic(client):
    from app.database import get_session
    from app import models
    from app.modules.agent.router import _agent_service
    from app.modules.agent.service import AgentService
    from sqlalchemy import select

    class ForbiddenProvider:
        def complete(self, messages, tools, model):
            raise AssertionError("receipt-only 请求不得调用模型")

    _agent_service.provider_override = ForbiddenProvider()
    user = make_user(client)
    me = client["api"].get(
        "/api/v1/me", headers=auth_headers(user["access_token"])
    ).json()
    plan_id = str(uuid.uuid4())
    base_state = {
        "pending_drafts": [{
            "draft_id": "draft-status", "plan_id": plan_id,
            "status": "pending_approval", "event": {"event": "x"},
        }],
        "recent_reference": {
            "storage_status": "pending_approval_not_saved",
            "draft_id": "draft-status",
        },
        "last_plan_id": plan_id,
    }

    db = get_session()
    AgentService._save_history(db, me["id"], "failed-receipt", [], base_state)
    AgentService._save_history(db, me["id"], "rejected-receipt", [], base_state)
    db.close()

    failed = _plan(client, user, "", session_id="failed-receipt", receipts=[{
        "plan_id": plan_id, "draft_id": "draft-status", "status": "failed",
    }])
    rejected = _plan(client, user, "", session_id="rejected-receipt", receipts=[{
        "plan_id": plan_id, "draft_id": "draft-status", "status": "rejected",
    }])
    assert failed.status_code == rejected.status_code == 200

    db = get_session()
    try:
        states = {
            row.session_id: row.state
            for row in db.execute(select(models.AgentSession).where(
                models.AgentSession.user_id == me["id"],
            )).scalars()
        }
    finally:
        db.close()
    assert states["failed-receipt"]["pending_drafts"][0]["last_receipt_status"] == "failed"
    assert states["failed-receipt"]["recent_reference"]["storage_status"] == "pending_approval_not_saved"
    assert states["rejected-receipt"]["pending_drafts"] == []
    assert states["rejected-receipt"]["recent_reference"]["storage_status"] == "rejected_draft"


def test_approved_receipt_with_explicit_instruction_targets_saved_event(client):
    from app.database import get_session
    from app import models
    from app.modules.agent.provider import ChatResult, ToolCall
    from app.modules.agent.router import _agent_service
    from app.modules.agent.service import AgentService
    from sqlalchemy import select

    user = make_user(client)
    me = client["api"].get(
        "/api/v1/me", headers=auth_headers(user["access_token"])
    ).json()
    plan_id = str(uuid.uuid4())
    draft_id = "draft-approved"
    sid = "approved-then-instruction"
    state = {
        "pending_drafts": [{
            "draft_id": draft_id, "plan_id": plan_id,
            "status": "pending_approval",
            "event": {"event": "已保存任务", "date": "2026-08-21"},
        }],
        "recent_reference": {
            "storage_status": "pending_approval_not_saved", "draft_id": draft_id,
        },
        "last_plan_id": plan_id,
    }
    db = get_session()
    AgentService._save_history(db, me["id"], sid, [], state)
    db.close()

    class SavedUpdateProvider:
        def __init__(self):
            self.calls = 0

        def complete(self, messages, tools, model):
            self.calls += 1
            if self.calls == 1:
                assert '"storage_status": "saved_event"' in messages[0]["content"]
                return ChatResult(content="", tool_calls=[ToolCall(
                    "list-saved", "list_events", {"keyword": "已保存任务"},
                )])
            if self.calls == 2:
                return ChatResult(content="", tool_calls=[ToolCall(
                    "update-saved", "update_event",
                    {"id": "saved-event-id", "event": "新标题", "scope": "all"},
                )])
            return ChatResult(content="已修改已保存日程。")

    provider = SavedUpdateProvider()
    _agent_service.provider_override = provider
    response = _plan(
        client, user, "把刚才那个标题改成新标题", session_id=sid,
        snapshot=[{"id": "saved-event-id", "event": "已保存任务", "date": "2026-08-21"}],
        receipts=[{
            "plan_id": plan_id, "draft_id": draft_id, "status": "approved",
            "event_id": "saved-event-id",
        }],
        continue_planning=True,
    )
    assert response.status_code == 200, response.text
    assert provider.calls == 3
    action = response.json()["actions"][0]
    assert action["type"] == "update"
    assert action["id"] == "saved-event-id"
    assert action["updates"] == {"event": "新标题"}
    assert action["scope"] == "all"
    db = get_session()
    try:
        saved_state = db.execute(select(models.AgentSession.state).where(
            models.AgentSession.user_id == me["id"],
            models.AgentSession.session_id == sid,
        )).scalar_one()
    finally:
        db.close()
    assert saved_state["pending_drafts"] == []
    assert saved_state["recent_reference"]["storage_status"] == "saved_event"
    assert saved_state["recent_reference"]["event_id"] == "saved-event-id"


def test_rejected_or_incomplete_receipt_never_marks_draft_saved():
    from app.modules.agent.service import AgentService

    plan_id = str(uuid.uuid4())
    draft = {
        "draft_id": "draft-receipt", "plan_id": plan_id,
        "status": "pending_approval", "event": {"event": "x"},
    }
    incomplete = AgentService._apply_receipts(
        {"pending_drafts": [draft]},
        [{"plan_id": plan_id, "draft_id": "draft-receipt", "status": "approved"}],
    )
    assert incomplete["pending_drafts"][0]["last_receipt_status"] == "failed"
    assert incomplete.get("recent_reference") is None

    rejected = AgentService._apply_receipts(
        {"pending_drafts": [draft]},
        [{"plan_id": plan_id, "draft_id": "draft-receipt", "status": "rejected"}],
    )
    assert rejected["pending_drafts"] == []
    assert rejected["recent_reference"]["storage_status"] == "rejected_draft"


def test_structured_state_survives_history_truncation_and_worker_restart(client):
    from app.database import get_session
    from app.modules.agent.service import AgentService

    user = make_user(client)
    me = client["api"].get(
        "/api/v1/me", headers=auth_headers(user["access_token"])
    ).json()
    state = {
        "pending_drafts": [{
            "draft_id": "draft-survives", "plan_id": str(uuid.uuid4()),
            "status": "pending_approval",
            "event": {"event": "截断后仍在", "date": "2026-08-21"},
        }],
        "tool_traces": [{"name": "create_event", "result": {"success": True}}],
    }
    sid = "state-restart-truncation"
    db = get_session()
    try:
        for i in range(12):
            AgentService._save_history(db, me["id"], sid, [
                {"role": "user", "content": f"u{i}"},
                {"role": "assistant", "content": f"a{i}"},
            ], state if i == 0 else None)
    finally:
        db.close()

    restarted_worker = AgentService()
    db = get_session()
    try:
        history, loaded_state = restarted_worker._load_session(db, me["id"], sid)
    finally:
        db.close()
    assert len(history) == 8
    assert history[0]["content"] == "u8"
    assert loaded_state == state
