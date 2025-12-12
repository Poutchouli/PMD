import os
from functools import lru_cache
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "IP Tracker API"
    app_version: str = "1.0"
    # Prefer Postgres/Timescale; fallback to sqlite for quick dev/tests
    database_url: str = Field(
        default=os.getenv(
            "DATABASE_URL",
            "sqlite+aiosqlite:///./pingmedaddy.db",
        )
    )
    ping_timeout: float = 1.0
    ping_concurrency_limit: int = 200
    admin_username: str = Field(default="admin")
    admin_password: str = Field(default="changeme")
    auth_secret: str = Field(default="super-secret-key")
    auth_token_minutes: int = Field(default=1440)

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


@lru_cache()
def get_settings() -> Settings:
    return Settings()
