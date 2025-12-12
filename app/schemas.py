from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field, IPvAnyAddress, ConfigDict


class TargetCreate(BaseModel):
    ip: IPvAnyAddress = Field(..., description="IP to monitor")
    frequency: int = Field(1, ge=1, le=3600, description="Seconds between pings")


class TargetOut(BaseModel):
    id: int
    ip: str
    frequency: int
    is_active: bool
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


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
