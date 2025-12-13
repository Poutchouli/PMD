from functools import lru_cache
from typing import List

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "IP Tracker API"
    app_version: str = "1.0"
    # Prefer Postgres/Timescale; fallback to sqlite for quick dev/tests
    database_url: str = Field(default="sqlite+aiosqlite:///./pingmedaddy.db")
    app_port: int = Field(default=6666)
    ping_timeout: float = 1.0
    ping_concurrency_limit: int = 200
    admin_username: str = Field(default="admin")
    admin_password: str = Field(default="changeme")
    auth_secret: str = Field(default="super-secret-key")
    auth_token_minutes: int = Field(default=1440)
    cors_origins: List[str] | str = Field(default="http://localhost:3000")
    traceroute_binary: str | None = Field(default=None)

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    @field_validator("cors_origins", mode="before")
    @classmethod
    def split_origins(cls, value):
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @field_validator("traceroute_binary", mode="before")
    @classmethod
    def empty_traceroute_binary(cls, value):
        if isinstance(value, str) and not value.strip():
            return None
        return value


@lru_cache()
def get_settings() -> Settings:
    return Settings()
