"""Pydantic request/response schemas.

These types are the frozen OpenAPI contract for frontend integration. Additive
changes are allowed; breaking changes must be versioned.
"""

import uuid
from datetime import date as date_type, datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

# --------------------------------------------------------------------------- auth


class RegisterRequest(BaseModel):
    invite_code: str = Field(min_length=1, max_length=64)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    device_name: str = Field(min_length=1, max_length=120)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.strip().lower()


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)
    device_name: str = Field(min_length=1, max_length=120)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.strip().lower()


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=10, max_length=256)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    device_id: uuid.UUID


class DeviceInfo(BaseModel):
    id: uuid.UUID
    name: str
    current: bool = False
    last_active_at: datetime
    created_at: datetime


class UserProfile(BaseModel):
    id: uuid.UUID
    email: str
    status: str
    email_verified_at: Optional[datetime] = None
    created_at: datetime


# --------------------------------------------------------------------------- sync
# 同步协议字段名遵循权威方案 §7：operationId / eventId / baseVersion / op / data。


class EventChange(BaseModel):
    eventId: uuid.UUID
    version: int = Field(ge=0)
    baseVersion: int = Field(ge=0, default=0)
    operationId: uuid.UUID
    op: Literal["upsert", "delete"]
    data: Optional[Dict[str, Any]] = None


class PushRequest(BaseModel):
    changes: List[EventChange] = Field(max_length=200)


class PushResultItem(BaseModel):
    eventId: uuid.UUID
    status: Literal["applied", "conflict", "idempotent", "error"]
    version: int
    serverVersion: Optional[int] = None
    data: Optional[Dict[str, Any]] = None
    serverData: Optional[Dict[str, Any]] = None
    deleted: bool = False
    message: Optional[str] = None


class PushResponse(BaseModel):
    results: List[PushResultItem]
    cursor: int


class CloudEvent(BaseModel):
    eventId: uuid.UUID
    version: int
    operationId: uuid.UUID
    seq: int
    deleted: bool = False
    trashUntil: Optional[date_type] = None
    data: Optional[Dict[str, Any]] = None


class PullResponse(BaseModel):
    cursor: int
    hasMore: bool = False
    reconcileRequired: bool = False
    events: List[CloudEvent] = []


class RestoreRequest(BaseModel):
    eventId: uuid.UUID


class SyncSnapshotResponse(BaseModel):
    cursor: int
    events: List[CloudEvent]


class TrashItem(BaseModel):
    eventId: uuid.UUID
    version: int
    deletedAt: datetime
    trashUntil: date_type
    data: Optional[Dict[str, Any]] = None


class TrashListResponse(BaseModel):
    items: List[TrashItem] = []


# --------------------------------------------------------------------------- agent


class AgentActionReceipt(BaseModel):
    plan_id: uuid.UUID
    draft_id: str = Field(min_length=1, max_length=80)
    status: Literal["approved", "rejected", "failed"]
    event_id: Optional[str] = Field(default=None, max_length=80)


class AgentPlanRequest(BaseModel):
    message: str = Field(default="", max_length=2000)
    date: Optional[date_type] = None
    session_id: Optional[str] = Field(default=None, max_length=80)
    snapshot: Optional[List[Dict[str, Any]]] = Field(default=None, max_length=500)
    receipts: List[AgentActionReceipt] = Field(default_factory=list, max_length=50)
    continue_planning: bool = False

    @model_validator(mode="after")
    def validate_message_or_receipts(self):
        if not self.message.strip() and not self.receipts:
            raise ValueError("message 或 receipts 至少提供一项")
        if self.receipts and not self.session_id:
            raise ValueError("处理 receipts 时必须提供 session_id")
        if self.continue_planning and not self.message.strip():
            raise ValueError("continue_planning 需要明确的 message")
        return self


class AgentAction(BaseModel):
    type: Literal["create", "update", "delete"]
    id: Optional[str] = None
    draft_id: Optional[str] = None
    event: Optional[Dict[str, Any]] = None
    updates: Optional[Dict[str, Any]] = None
    scope: Optional[Literal["future", "all", "past"]] = None
    effective_date: Optional[str] = None


class AgentUsage(BaseModel):
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_ms: int = 0


class AgentBudget(BaseModel):
    enabled: bool = False
    remaining_usd: Optional[float] = None


class AgentPlanResponse(BaseModel):
    plan_id: uuid.UUID
    message: str
    actions: List[AgentAction] = []
    configured: bool = True
    usage: AgentUsage
    budget: AgentBudget


# --------------------------------------------------------------------------- admin


class AdminLoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=128)


class AdminTokenResponse(BaseModel):
    token: str
    token_type: str = "bearer"
    expires_in: int


class InviteCreateRequest(BaseModel):
    expires_days: Optional[int] = Field(default=None, ge=1, le=365)
    max_uses: int = Field(default=1, ge=1, le=100)


class InviteView(BaseModel):
    id: int
    status: str
    expires_at: Optional[datetime] = None
    max_uses: int = 1
    use_count: int = 0
    used_by_user_id: Optional[uuid.UUID] = None
    created_at: datetime
    used_at: Optional[datetime] = None


class InviteCreateResponse(InviteView):
    code: str


class UserAdminView(BaseModel):
    id: uuid.UUID
    email: str
    status: str
    created_at: datetime
    device_count: int = 0


class UserStatusUpdate(BaseModel):
    status: Literal["active", "disabled"]


class UsagePerDay(BaseModel):
    date: str
    request_count: int = 0
    total_prompt_tokens: int = 0
    total_completion_tokens: int = 0
    estimated_cost_usd: float = 0.0


class UsagePerUser(BaseModel):
    user_id: uuid.UUID
    email: str
    request_count: int = 0
    total_cost_usd: float = 0.0


class UsageSummary(BaseModel):
    total_request_count: int = 0
    total_prompt_tokens: int = 0
    total_completion_tokens: int = 0
    total_cost_usd: float = 0.0
    per_day: List[UsagePerDay] = []
    per_user: List[UsagePerUser] = []


class SettingsView(BaseModel):
    ai_enabled: bool = True
    ai_monthly_budget_usd: float = 0.0


class SettingsUpdate(BaseModel):
    ai_enabled: bool
    ai_monthly_budget_usd: float = Field(ge=0.0)


class AuditLogView(BaseModel):
    id: int
    actor: str
    action: str
    target_type: Optional[str] = None
    target_id: Optional[str] = None
    created_at: datetime


# --------------------------------------------------------------------------- common


class HealthResponse(BaseModel):
    status: str
    version: str
    database: str
    time: str


class ErrorResponse(BaseModel):
    detail: str
