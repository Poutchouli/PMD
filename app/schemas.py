from datetime import datetime
from typing import List, Optional
from pydantic import AnyHttpUrl, BaseModel, Field, IPvAnyAddress, ConfigDict, field_validator


class TargetCreate(BaseModel):
    ip: IPvAnyAddress = Field(..., description="IP to monitor")
    frequency: int = Field(1, ge=1, le=3600, description="Seconds between pings")
    url: Optional[AnyHttpUrl] = Field(None, description="Optional interface URL")
    notes: Optional[str] = Field(None, max_length=2000, description="Free-form notes")

    @field_validator("url", mode="before")
    @classmethod
    def _normalize_url(cls, value: Optional[str]):
        if value is None:
            return None
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        return value

    @field_validator("notes", mode="before")
    @classmethod
    def _normalize_notes(cls, value: Optional[str]):
        if value is None:
            return None
        if isinstance(value, str) and not value.strip():
            return None
        return value


class TargetOut(BaseModel):
    id: int
    ip: str
    frequency: int
    is_active: bool
    created_at: datetime
    url: Optional[str]
    notes: Optional[str]
    model_config = ConfigDict(from_attributes=True)


class TargetUpdate(BaseModel):
    frequency: Optional[int] = Field(None, ge=1, le=3600)
    url: Optional[AnyHttpUrl] = Field(None, description="Optional interface URL")
    notes: Optional[str] = Field(None, max_length=2000)

    model_config = ConfigDict(extra="forbid")

    @field_validator("url", mode="before")
    @classmethod
    def _normalize_update_url(cls, value: Optional[str]):
        if value is None:
            return None
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        return value

    @field_validator("notes", mode="before")
    @classmethod
    def _normalize_update_notes(cls, value: Optional[str]):
        if value is None:
            return None
        if isinstance(value, str) and not value.strip():
            return None
        return value


class TargetStatus(BaseModel):
    message: str
    id: int


class PingLogOut(BaseModel):
    time: datetime
    latency_ms: Optional[float]
    hops: Optional[int]
    packet_loss: bool
    model_config = ConfigDict(from_attributes=True)


class EventLogOut(BaseModel):
    id: int
    target_id: Optional[int]
    event_type: str
    message: str
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class LatencyPoint(BaseModel):
    bucket: datetime
    avg_latency_ms: Optional[float]
    min_latency_ms: Optional[float]
    max_latency_ms: Optional[float]
    loss_rate: float
    sample_count: int


class TargetInsights(BaseModel):
    target_id: int
    target_ip: str
    created_at: datetime
    window_minutes: int
    window_start: datetime
    window_end: datetime
    sample_count: int
    loss_count: int
    uptime_percent: Optional[float]
    latency_avg_ms: Optional[float]
    latency_min_ms: Optional[float]
    latency_max_ms: Optional[float]
    latency_p50_ms: Optional[float]
    latency_p95_ms: Optional[float]
    latency_p99_ms: Optional[float]
    timeline: List[LatencyPoint]


class TracerouteHop(BaseModel):
    hop: int
    host: Optional[str]
    ip: Optional[str]
    rtt_ms: Optional[float]
    is_timeout: bool
    raw: str


class TracerouteResponse(BaseModel):
    target_id: int
    target_ip: str
    started_at: datetime
    finished_at: datetime
    duration_ms: float
    hops: List[TracerouteHop]
