"""Sync business logic.

Event model
-----------
- Every event has a stable UUID `event_id` and a per-event integer `version`.
- A client change carries `base_version` (the version it was built on) and an
  `operation_id` used for idempotent retries.
- Each accepted mutation advances the event version and bumps the per-user
  global change sequence (`seq`) used for incremental pulls.
- Delete is a soft delete: body is kept for the trash window (30d default),
  then cleared to a tombstone that lives until the tombstone retention (180d
  default), after which the row is purged.
- Optimistic concurrency: a change whose `base_version` is behind the server
  version is rejected with `conflict` and both versions are returned; the
  server state is never overwritten.
"""

import uuid
from datetime import date, timedelta
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ... import models
from ...config import settings
from ...timeutil import utcnow


class SyncError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def next_seq(db: Session, user_id: uuid.UUID) -> int:
    cursor = db.execute(
        select(models.SyncCursor)
        .where(models.SyncCursor.user_id == user_id)
        .with_for_update()
    ).scalar_one_or_none()
    if cursor is None:
        cursor = models.SyncCursor(user_id=user_id, last_seq=1)
        db.add(cursor)
    else:
        cursor.last_seq += 1
    db.flush()
    return cursor.last_seq


def _validate_data(data) -> None:
    if data is None:
        return
    if not isinstance(data, dict):
        raise SyncError(422, "event data must be a JSON object")
    title = data.get("event")
    if title is not None and (not isinstance(title, str) or not title.strip()):
        raise SyncError(422, "event data 'event' (title) must be a non-empty string")


def _row_to_cloud_event(row: models.CalendarEvent) -> dict:
    return {
        "eventId": row.event_id,
        "version": row.version,
        "operationId": row.operation_id,
        "seq": row.seq,
        "deleted": row.deleted_at is not None,
        "trashUntil": row.trash_until,
        "data": row.data,
    }


def apply_push(db: Session, user_id: uuid.UUID, changes: list) -> list:
    # Serialize version checks and the first cursor creation for this account.
    db.execute(select(models.User).where(models.User.id == user_id).with_for_update()).scalar_one()
    results = []
    for change in changes:
        event_id = change["eventId"]
        operation_id = change["operationId"]
        op = change["op"]
        _validate_data(change.get("data"))
        results.append(
            _apply_change(db, user_id, event_id, operation_id, op, change)
        )
    cursor = current_cursor(db, user_id)
    db.commit()
    return results, cursor


def _apply_change(db, user_id, event_id, operation_id, op, change) -> dict:
    row = db.execute(
        select(models.CalendarEvent).where(
            models.CalendarEvent.user_id == user_id,
            models.CalendarEvent.event_id == event_id,
        )
    ).scalar_one_or_none()

    if row is None:
        idem = db.execute(
            select(models.CalendarEvent).where(
                models.CalendarEvent.user_id == user_id,
                models.CalendarEvent.operation_id == operation_id,
            )
        ).scalar_one_or_none()
        if idem is not None:
            return _result("idempotent", event_id, row=idem)

        if op == "delete":
            row = _create_tombstone(db, user_id, event_id, operation_id, change)
            return _result("applied", event_id, row=row)

        version = max(1, int(change.get("version") or 1))
        row = models.CalendarEvent(
            user_id=user_id,
            event_id=event_id,
            operation_id=operation_id,
            version=version,
            base_version=int(change.get("baseVersion") or 0),
            data=change.get("data"),
            deleted_at=None,
            trash_until=None,
            seq=next_seq(db, user_id),
        )
        db.add(row)
        db.flush()
        return _result("applied", event_id, row=row)

    # existing row
    if row.operation_id == operation_id:
        return _result("idempotent", event_id, row=row)

    base_version = int(change.get("baseVersion") or 0)
    if base_version < row.version:
        return {
            "eventId": event_id,
            "status": "conflict",
            "version": row.version,
            "serverVersion": row.version,
            "data": change.get("data"),
            "serverData": row.data,
            "deleted": row.deleted_at is not None,
            "message": "版本冲突：本机版本落后于云端，未覆盖任何数据",
        }

    now = utcnow()
    if op == "upsert":
        # Restoring an event that was soft-deleted is an upsert.
        new_version = max(base_version, row.version) + 1
        row.version = new_version
        row.base_version = base_version
        row.operation_id = operation_id
        row.data = change.get("data")
        row.deleted_at = None
        row.trash_until = None
        row.updated_at = now
        row.seq = next_seq(db, user_id)
    else:  # delete
        if row.deleted_at is not None:
            return _result("idempotent", event_id, row=row)
        new_version = max(base_version, row.version) + 1
        row.version = new_version
        row.base_version = base_version
        row.operation_id = operation_id
        row.deleted_at = now
        row.trash_until = date.today() + timedelta(days=settings.trash_retention_days)
        row.updated_at = now
        row.seq = next_seq(db, user_id)
    db.flush()
    return _result("applied", event_id, row=row)


def _create_tombstone(db, user_id, event_id, operation_id, change) -> models.CalendarEvent:
    row = models.CalendarEvent(
        user_id=user_id,
        event_id=event_id,
        operation_id=operation_id,
        version=max(1, int(change.get("version") or 1)),
        base_version=int(change.get("baseVersion") or 0),
        data=None,
        deleted_at=utcnow(),
        trash_until=date.today() + timedelta(days=settings.trash_retention_days),
        seq=next_seq(db, user_id),
    )
    db.add(row)
    db.flush()
    return row


def _result(status, event_id, row) -> dict:
    return {
        "eventId": event_id,
        "status": status,
        "version": row.version,
        "serverVersion": row.version,
        "data": row.data,
        "serverData": row.data,
        "deleted": row.deleted_at is not None,
    }


def current_cursor(db: Session, user_id: uuid.UUID) -> int:
    cursor = db.execute(
        select(models.SyncCursor).where(models.SyncCursor.user_id == user_id)
    ).scalar_one_or_none()
    return cursor.last_seq if cursor else 0


def snapshot(db: Session, user_id: uuid.UUID) -> dict:
    # One SQL statement: records and watermark share a PostgreSQL MVCC snapshot.
    rows = db.execute(
        select(models.CalendarEvent, models.SyncCursor.last_seq)
        .select_from(models.User)
        .outerjoin(models.SyncCursor, models.SyncCursor.user_id == models.User.id)
        .outerjoin(models.CalendarEvent, models.CalendarEvent.user_id == models.User.id)
        .where(models.User.id == user_id)
        .order_by(models.CalendarEvent.seq)
    ).all()
    return {
        "cursor": int(rows[0][1] or 0) if rows else 0,
        "events": [_row_to_cloud_event(row[0]) for row in rows if row[0] is not None],
    }


def _min_seq(db: Session, user_id: uuid.UUID) -> Optional[int]:
    return db.execute(
        select(func.min(models.CalendarEvent.seq)).where(
            models.CalendarEvent.user_id == user_id
        )
    ).scalar()


def pull(db: Session, user_id: uuid.UUID, cursor: Optional[int], limit: int) -> dict:
    min_seq = _min_seq(db, user_id)
    reconcile = False
    if cursor is not None:
        if min_seq is None:
            reconcile = cursor > 0
        else:
            reconcile = cursor < min_seq

    if reconcile:
        rows = db.execute(
            select(models.CalendarEvent)
            .where(models.CalendarEvent.user_id == user_id)
            .order_by(models.CalendarEvent.seq.asc())
        ).scalars().all()
        events = [_row_to_cloud_event(row) for row in rows]
        return {
            "cursor": events[-1]["seq"] if events else (cursor or 0),
            "hasMore": False,
            "reconcileRequired": True,
            "events": events,
        }

    base = cursor if cursor is not None else 0
    rows = db.execute(
        select(models.CalendarEvent)
        .where(models.CalendarEvent.user_id == user_id, models.CalendarEvent.seq > base)
        .order_by(models.CalendarEvent.seq.asc())
        .limit(limit + 1)
    ).scalars().all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    events = [_row_to_cloud_event(row) for row in rows]
    new_cursor = events[-1]["seq"] if events else base
    return {
        "cursor": new_cursor,
        "hasMore": has_more,
        "reconcileRequired": False,
        "events": events,
    }


def list_trash(db: Session, user_id: uuid.UUID) -> list:
    rows = db.execute(
        select(models.CalendarEvent)
        .where(
            models.CalendarEvent.user_id == user_id,
            models.CalendarEvent.deleted_at.is_not(None),
            models.CalendarEvent.data.is_not(None),
        )
        .order_by(models.CalendarEvent.deleted_at.desc())
    ).scalars().all()
    return [
        {
            "eventId": row.event_id,
            "version": row.version,
            "deletedAt": row.deleted_at,
            "trashUntil": row.trash_until,
            "data": row.data,
        }
        for row in rows
    ]


def restore(db: Session, user_id: uuid.UUID, event_id: uuid.UUID) -> dict:
    db.execute(select(models.User).where(models.User.id == user_id).with_for_update()).scalar_one()
    row = db.execute(
        select(models.CalendarEvent).where(
            models.CalendarEvent.user_id == user_id,
            models.CalendarEvent.event_id == event_id,
        )
    ).scalar_one_or_none()
    if row is None:
        raise SyncError(404, "日程不存在")
    if row.deleted_at is None:
        raise SyncError(400, "日程不在回收站中")
    row.deleted_at = None
    row.trash_until = None
    row.version = row.version + 1
    row.updated_at = utcnow()
    row.seq = next_seq(db, user_id)
    db.commit()
    return _row_to_cloud_event(row)


def purge_expired(
    db: Session,
    trash_retention_days: Optional[int] = None,
    tombstone_retention_days: Optional[int] = None,
) -> dict:
    """Clear trashed bodies after the trash window and drop tombstones after
    the tombstone retention window. Safe to call periodically."""
    trash_days = trash_retention_days or settings.trash_retention_days
    tombstone_days = tombstone_retention_days or settings.tombstone_retention_days
    cutoff_date = date.today() - timedelta(days=trash_days)
    cutoff_dt = utcnow() - timedelta(days=tombstone_days)

    cleared = db.execute(
        update(models.CalendarEvent)
        .where(
            models.CalendarEvent.deleted_at.is_not(None),
            models.CalendarEvent.trash_until < cutoff_date,
            models.CalendarEvent.data.is_not(None),
        )
        .values(data=None)
    ).rowcount

    purged = db.execute(
        sa_delete(models.CalendarEvent)
        .where(
            models.CalendarEvent.deleted_at.is_not(None),
            models.CalendarEvent.deleted_at < cutoff_dt,
        )
    ).rowcount

    db.commit()
    return {"bodies_cleared": int(cleared), "tombstones_purged": int(purged)}
