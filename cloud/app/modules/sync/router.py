"""Sync HTTP routes."""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ...config import settings
from ...database import get_db
from ...deps import require_user
from ...schemas import (
    CloudEvent,
    PullResponse,
    PushRequest,
    PushResponse,
    SyncSnapshotResponse,
    RestoreRequest,
    TrashItem,
    TrashListResponse,
)
from . import service

router = APIRouter(tags=["sync"])


@router.get("/snapshot", response_model=SyncSnapshotResponse)
def snapshot(current=Depends(require_user), db: Session = Depends(get_db)):
    return service.snapshot(db, current["user"].id)


@router.get("/pull", response_model=PullResponse)
def pull(
    cursor: Optional[int] = Query(default=None, ge=0),
    limit: int = Query(default=500, ge=1, le=1000),
    current=Depends(require_user),
    db: Session = Depends(get_db),
):
    return service.pull(db, current["user"].id, cursor, limit)


@router.post("/push", response_model=PushResponse)
def push(
    payload: PushRequest,
    current=Depends(require_user),
    db: Session = Depends(get_db),
):
    changes = [change.model_dump() for change in payload.changes]
    results, cursor = service.apply_push(db, current["user"].id, changes)
    return {"results": results, "cursor": cursor}


@router.get("/trash", response_model=TrashListResponse)
def trash(current=Depends(require_user), db: Session = Depends(get_db)):
    items = service.list_trash(db, current["user"].id)
    return {"items": items}


@router.post("/restore", response_model=CloudEvent)
def restore(
    payload: RestoreRequest,
    current=Depends(require_user),
    db: Session = Depends(get_db),
):
    try:
        return service.restore(db, current["user"].id, payload.eventId)
    except service.SyncError as error:
        from fastapi import HTTPException

        raise HTTPException(status_code=error.status_code, detail=error.detail)


def run_purge():
    """Best-effort purge of expired trash bodies / tombstones (call periodically)."""
    from ...database import SessionLocal

    db = SessionLocal()
    try:
        service.purge_expired(db)
    finally:
        db.close()
