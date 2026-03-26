from datetime import datetime
from typing import Dict, List, Optional
from pydantic import AnyHttpUrl, BaseModel, Field, ConfigDict, field_validator

from app.utils import resolve_host


# ============ Groups ============

class GroupCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)
    color: str = Field("#6B7280", pattern=r"^#[0-9A-Fa-f]{6}$")


class GroupOut(BaseModel):
    id: int
    name: str
    color: str
    target_count: int = 0
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class GroupUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=50)
    color: Optional[str] = Field(None, pattern=r"^#[0-9A-Fa-f]{6}$")
    model_config = ConfigDict(extra="forbid")


# ============ Targets ============

class TargetImportRow(BaseModel):
    ip: str = Field(..., description="IP or hostname to monitor")
    frequency: int = Field(1, ge=1, le=3600, description="Seconds between pings")
    url: Optional[AnyHttpUrl] = Field(None, description="Optional interface URL")
    notes: Optional[str] = Field(None, max_length=2000, description="Free-form notes")
    is_active: bool = Field(True, description="Whether monitoring starts immediately")
    group: Optional[str] = Field(None, max_length=50, description="Group name (created if missing)")

    model_config = ConfigDict(extra="ignore")

    @field_validator("ip", mode="before")
    @classmethod
    def _resolve_ip(cls, value: str) -> str:
        return resolve_host(value)

    @field_validator("url", mode="before")
    @classmethod
    def _normalize_import_url(cls, value: Optional[str]):
        if value is None:
            return None
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        return value

    @field_validator("notes", mode="before")
    @classmethod
    def _normalize_import_notes(cls, value: Optional[str]):
        if value is None:
            return None
        if isinstance(value, str) and not value.strip():
            return None
        return value


class TargetCreate(BaseModel):
    ip: str = Field(..., description="IP or hostname to monitor")
    frequency: int = Field(1, ge=1, le=3600, description="Seconds between pings")
    url: Optional[AnyHttpUrl] = Field(None, description="Optional interface URL")
    notes: Optional[str] = Field(None, max_length=2000, description="Free-form notes")
    group_id: Optional[int] = Field(None, description="Optional group ID")

    @field_validator("ip", mode="before")
    @classmethod
    def _resolve_ip(cls, value: str) -> str:
        return resolve_host(value)

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
    group_id: Optional[int] = None
    group_name: Optional[str] = None
    group_color: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)


class TargetUpdate(BaseModel):
    frequency: Optional[int] = Field(None, ge=1, le=3600)
    url: Optional[AnyHttpUrl] = Field(None, description="Optional interface URL")
    notes: Optional[str] = Field(None, max_length=2000)
    group_id: Optional[int] = Field(None, description="Group ID (null to remove)")

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


class TargetImportResult(BaseModel):
    row_count: int
    created: int
    skipped_existing: int
    errors: List[str]


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


# ============ User Preferences ============

class UserPreferenceUpdate(BaseModel):
    theme: Optional[str] = Field(None, pattern="^(light|dark|system)$")
    language: Optional[str] = Field(None, min_length=2, max_length=5)
    event_filters: Optional[Dict[str, List[str]]] = Field(None, description="Per-target event type filters: {'<target_id>': ['start','stop',...]}")


class UserPreferenceResponse(BaseModel):
    username: str
    theme: str
    language: str
    event_filters: Optional[Dict[str, List[str]]] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ============ Generic ============

class MessageResponse(BaseModel):
    message: str
    detail: Optional[str] = None


# ============ Services Discovery ============

class DiscoveredServiceResponse(BaseModel):
    slug: str
    name: str
    description: Optional[str] = None
    api_url: str
    frontend_url: Optional[str] = None
    version: Optional[str] = None
    status: Optional[str] = None
    is_healthy: bool = True


class ServiceDiscoveryResponse(BaseModel):
    count: int
    services: List[DiscoveredServiceResponse]
    cached_at: Optional[str] = None


# ============ Backup / Restore ============

class BackupMetadata(BaseModel):
    backup_id: str
    app_slug: str
    app_version: str
    created_at: str
    created_by: str
    total_tables: int = 0
    total_rows: int = 0
    total_size_bytes: int = 0
    total_size_human: str = ""
    checksum: str = ""


class SyncToHubRequest(BaseModel):
    description: Optional[str] = None
    tags: List[str] = Field(default_factory=list)


class SyncFromHubRequest(BaseModel):
    backup_id: Optional[str] = None
    clear_existing: bool = False
