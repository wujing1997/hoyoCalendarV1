"""Sync acceptance tests: idempotency, optimistic concurrency, trash/tombstone,
delete/restore, cursor pull, reconcile, user isolation."""

import uuid
from datetime import date, timedelta

from .helpers import auth_headers, new_event_id, make_user, upsert_change


def _push(client, user, changes):
    return client["api"].post(
        "/api/v1/sync/push",
        json={"changes": changes},
        headers=auth_headers(user["access_token"]),
    )


def _pull(client, user, cursor=None):
    url = "/api/v1/sync/pull"
    if cursor is not None:
        url += f"?cursor={cursor}"
    return client["api"].get(url, headers=auth_headers(user["access_token"]))


def test_snapshot_includes_active_and_deleted_records_at_one_watermark(client):
    user = make_user(client)
    a, b = new_event_id(), new_event_id()
    _push(client, user, [upsert_change(a, 1, 0, {"event": "保留"}), upsert_change(b, 1, 0, {"event": "删除"})])
    pushed = _push(client, user, [upsert_change(b, 2, 1, None, op="delete")]).json()
    response = client["api"].get("/api/v1/sync/snapshot", headers=auth_headers(user["access_token"]))
    assert response.status_code == 200
    snapshot = response.json()
    assert snapshot["cursor"] == pushed["cursor"]
    assert {event["eventId"] for event in snapshot["events"]} == {a, b}
    assert next(event for event in snapshot["events"] if event["eventId"] == b)["deleted"] is True
    other = make_user(client)
    empty = client["api"].get("/api/v1/sync/snapshot", headers=auth_headers(other["access_token"])).json()
    assert empty == {"cursor": 0, "events": []}


def test_snapshot_requires_authentication(client):
    assert client["api"].get("/api/v1/sync/snapshot").status_code == 401


def test_concurrent_updates_accept_one_and_conflict_the_other(client):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from app.database import SessionLocal
    from app.modules.sync import service
    from app.schemas import EventChange
    from app import models
    from sqlalchemy import select

    user = make_user(client)
    event_id = new_event_id()
    _push(client, user, [upsert_change(event_id, 1, 0, {"event": "初始"})])
    with SessionLocal() as db:
        user_id = db.execute(select(models.User.id).where(models.User.email == user["email"])).scalar_one()
    barrier = Barrier(2)

    def update(title):
        change = EventChange(**upsert_change(event_id, 2, 1, {"event": title})).model_dump()
        with SessionLocal() as db:
            barrier.wait(timeout=10)
            results, _ = service.apply_push(db, user_id, [change])
            return results[0]["status"]

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(update, ["设备 A", "设备 B"]))
    assert sorted(statuses) == ["applied", "conflict"]
    assert _pull(client, user).json()["events"][0]["version"] == 2


def test_push_then_pull_roundtrip(client):
    user = make_user(client)
    event_id = new_event_id()
    change = upsert_change(event_id, version=1, base_version=0, data={
        "event": "项目评审", "date": "2026-08-10", "time": "10:00",
    })
    pushed = _push(client, user, [change])
    assert pushed.status_code == 200, pushed.text
    assert pushed.json()["results"][0]["status"] == "applied"

    pulled = _pull(client, user)
    assert pulled.status_code == 200
    assert len(pulled.json()["events"]) == 1
    event = pulled.json()["events"][0]
    assert event["eventId"] == event_id
    assert event["data"]["event"] == "项目评审"
    assert pulled.json()["cursor"] == pushed.json()["cursor"]


def test_push_is_idempotent_by_operation_id(client):
    user = make_user(client)
    event_id = new_event_id()
    change = upsert_change(event_id, version=1, base_version=0, data={"event": "开会"})
    first = _push(client, user, [change])
    second = _push(client, user, [change])  # same operation_id
    assert first.json()["results"][0]["status"] == "applied"
    assert second.json()["results"][0]["status"] == "idempotent"
    pulled = _pull(client, user)
    assert len(pulled.json()["events"]) == 1


def test_incremental_cursor_only_returns_new_changes(client):
    user = make_user(client)
    event_a = new_event_id()
    _push(client, user, [upsert_change(event_a, 1, 0, {"event": "A"})])
    cursor = _pull(client, user).json()["cursor"]

    event_b = new_event_id()
    _push(client, user, [upsert_change(event_b, 1, 0, {"event": "B"})])

    pulled = _pull(client, user, cursor)
    events = pulled.json()["events"]
    assert len(events) == 1
    assert events[0]["eventId"] == event_b


def test_conflict_returns_both_versions_and_does_not_overwrite(client):
    user = make_user(client)
    event_id = new_event_id()
    base = upsert_change(event_id, 1, 0, {"event": "初始", "time": "09:00"})
    assert _push(client, user, [base]).json()["results"][0]["status"] == "applied"

    # device A updates
    update_a = upsert_change(event_id, 2, 1, {"event": "初始", "time": "10:00"})
    assert _push(client, user, [update_a]).json()["results"][0]["status"] == "applied"

    # device B tries a stale update on base_version 1
    stale = upsert_change(event_id, 2, 1, {"event": "初始", "time": "20:00"})
    resp = _push(client, user, [stale])
    result = resp.json()["results"][0]
    assert result["status"] == "conflict"
    assert result["serverData"]["time"] == "10:00"
    assert result["data"]["time"] == "20:00"
    # server version unchanged
    pulled = _pull(client, user)
    event = next(e for e in pulled.json()["events"] if e["eventId"] == event_id)
    assert event["data"]["time"] == "10:00"
    assert event["version"] == 2


def test_forward_base_version_accepted(client):
    user = make_user(client)
    event_id = new_event_id()
    # client made two offline edits: jumps to base_version 2
    change = upsert_change(event_id, 3, 2, {"event": "离线批量编辑", "time": "12:00"})
    resp = _push(client, user, [change])
    assert resp.json()["results"][0]["status"] == "applied"
    assert resp.json()["results"][0]["version"] == 3


def test_delete_restore_and_trash(client):
    user = make_user(client)
    event_id = new_event_id()
    _push(client, user, [upsert_change(event_id, 1, 0, {"event": "要删除", "note": "正文"})])

    deleted = _push(client, user, [upsert_change(event_id, 2, 1, None, op="delete")])
    assert deleted.json()["results"][0]["status"] == "applied"
    assert deleted.json()["results"][0]["deleted"] is True

    trash = client["api"].get("/api/v1/sync/trash", headers=auth_headers(user["access_token"]))
    assert trash.status_code == 200
    assert len(trash.json()["items"]) == 1
    assert trash.json()["items"][0]["data"]["note"] == "正文"

    restored = client["api"].post(
        "/api/v1/sync/restore",
        json={"eventId": event_id},
        headers=auth_headers(user["access_token"]),
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["deleted"] is False
    assert client["api"].get("/api/v1/sync/trash", headers=auth_headers(user["access_token"])).json()["items"] == []


def test_delete_of_unknown_event_creates_tombstone(client):
    user = make_user(client)
    event_id = new_event_id()
    resp = _push(client, user, [upsert_change(event_id, 1, 0, None, op="delete")])
    assert resp.json()["results"][0]["status"] == "applied"
    pulled = _pull(client, user)
    event = pulled.json()["events"][0]
    assert event["deleted"] is True
    assert event["data"] is None


def test_purge_clears_body_then_removes_tombstone(client):
    from datetime import datetime, timezone

    user = make_user(client)
    event_id = new_event_id()
    _push(client, user, [upsert_change(event_id, 1, 0, {"event": "过期任务", "note": "敏感正文"})])
    _push(client, user, [upsert_change(event_id, 2, 1, None, op="delete")])

    # simulate a tombstone older than the 30-day trash window and the 180-day retention
    from app.database import get_session
    from app import models
    from sqlalchemy import select

    db = get_session()
    row = db.execute(select(models.CalendarEvent).where(models.CalendarEvent.event_id == event_id)).scalar_one()
    old = datetime.now(timezone.utc) - timedelta(days=200)
    row.deleted_at = old
    row.trash_until = date.today() - timedelta(days=40)
    db.commit()
    db.close()

    from app.modules.sync.service import purge_expired

    db = get_session()
    result = purge_expired(db, trash_retention_days=30, tombstone_retention_days=180)
    assert result["tombstones_purged"] == 1
    db.close()

    pulled = _pull(client, user)
    assert pulled.json()["events"] == []


def test_purge_clears_trashed_body_within_tombstone_window(client):
    user = make_user(client)
    event_id = new_event_id()
    _push(client, user, [upsert_change(event_id, 1, 0, {"event": "待清理", "note": "正文"})])
    _push(client, user, [upsert_change(event_id, 2, 1, None, op="delete")])

    from app.database import get_session
    from app import models
    from sqlalchemy import select

    db = get_session()
    row = db.execute(select(models.CalendarEvent).where(models.CalendarEvent.event_id == event_id)).scalar_one()
    row.trash_until = date.today() - timedelta(days=31)
    db.commit()
    db.close()

    from app.modules.sync.service import purge_expired

    db = get_session()
    result = purge_expired(db, trash_retention_days=30, tombstone_retention_days=180)
    assert result["bodies_cleared"] == 1
    db.close()

    pulled = _pull(client, user)
    event = pulled.json()["events"][0]
    assert event["deleted"] is True
    assert event["data"] is None


def test_reconcile_when_cursor_behind_purge(client):
    user = make_user(client)
    event_id = new_event_id()
    _push(client, user, [upsert_change(event_id, 1, 0, {"event": "A"})])
    cursor = _pull(client, user).json()["cursor"]

    from app.database import get_session
    from sqlalchemy import text

    db = get_session()
    db.execute(text("DELETE FROM calendar_events WHERE user_id=(SELECT id FROM users WHERE email=:e)").params(e=user["email"]))
    db.commit()
    db.close()

    pulled = _pull(client, user, cursor)
    assert pulled.json()["reconcileRequired"] is True


def test_user_isolation_pull_and_push(client):
    user_a = make_user(client, email=f"iso-a-{uuid.uuid4().hex[:8]}@example.com")
    user_b = make_user(client, email=f"iso-b-{uuid.uuid4().hex[:8]}@example.com")
    event_id = new_event_id()
    _push(client, user_a, [upsert_change(event_id, 1, 0, {"event": "A私密"})])

    pulled_b = _pull(client, user_b)
    assert pulled_b.json()["events"] == []

    # B cannot push a change that lands on A's event
    _push(client, user_b, [upsert_change(event_id, 2, 1, {"event": "篡改"} )])
    pulled_a = _pull(client, user_a)
    event = pulled_a.json()["events"][0]
    assert event["data"]["event"] == "A私密"
    assert event["version"] == 1


def test_trash_is_user_scoped(client):
    user_a = make_user(client)
    user_b = make_user(client)
    event_id = new_event_id()
    _push(client, user_a, [upsert_change(event_id, 1, 0, {"event": "A的"})])
    _push(client, user_a, [upsert_change(event_id, 2, 1, None, op="delete")])
    trash_b = client["api"].get("/api/v1/sync/trash", headers=auth_headers(user_b["access_token"]))
    assert trash_b.json()["items"] == []


def test_pull_without_auth_rejected(client):
    resp = client["api"].get("/api/v1/sync/pull")
    assert resp.status_code == 401
