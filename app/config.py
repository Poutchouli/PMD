"""
Configuration de l'application PMD avec intégration Hub.
"""
import os
import socket
from functools import lru_cache
from pathlib import Path
from typing import List, Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def get_app_version() -> str:
    """Lit la version depuis le fichier VERSION à la racine du projet."""
    possible_paths = [
        Path(__file__).parent.parent / "VERSION",
        Path(__file__).parent / "VERSION",
        Path("/app/VERSION"),
    ]
    for path in possible_paths:
        if path.exists():
            return path.read_text().strip()
    return "0.0.0"


APP_VERSION = get_app_version()


def get_docker_host_ip() -> Optional[str]:
    """Récupère l'IP externe de l'hôte Docker depuis un conteneur."""
    app_host = os.environ.get("APP_HOST")
    if app_host:
        return app_host
    hub_host = os.environ.get("HUB_HOST")
    if hub_host:
        return hub_host
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if not ip.startswith("172."):
                return ip
    except Exception:
        pass
    return None


def is_running_in_docker() -> bool:
    """Détecte si on tourne dans un conteneur Docker."""
    if Path("/.dockerenv").exists():
        return True
    try:
        with open("/proc/1/cgroup") as f:
            return "docker" in f.read()
    except FileNotFoundError:
        pass
    return False


def get_local_ip() -> str:
    """Détecte l'IP locale de la machine."""
    if is_running_in_docker():
        docker_host = get_docker_host_ip()
        if docker_host:
            return docker_host
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


class Settings(BaseSettings):
    """Configuration de l'application PMD."""

    # --- Hub identification ---
    APP_SLUG: str = "pmd"
    APP_NAME: str = "PingMeDaddy"
    APP_DESCRIPTION: str = "Network monitoring — ping, latency, traceroute"

    # Host de cette application (laisser vide si même serveur que le Hub)
    APP_HOST: Optional[str] = None

    # Ports HTTP
    API_PORT: int = 6666
    FRONTEND_PORT: int = 3000

    # Hub connectivity
    HUB_HOST: Optional[str] = None
    HUB_API_PORT: int = 8000
    HUB_FRONTEND_PORT: int = 80

    # M2M
    IS_SHARED: bool = False

    # --- PMD-specific ---
    database_url: str = Field(default="sqlite+aiosqlite:///./pingmedaddy.db")
    ping_timeout: float = 1.0
    ping_concurrency_limit: int = 200
    cors_origins: List[str] | str = Field(default="http://localhost:3000")
    traceroute_binary: str | None = Field(default=None)

    # Storage / Uploads (backups)
    UPLOADS_DIR: str = "/app/uploads"

    # Debug
    DEBUG: bool = False

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @field_validator("APP_HOST", "HUB_HOST", mode="before")
    @classmethod
    def empty_str_to_none(cls, v):
        if v == "":
            return None
        return v

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

    # --- Computed properties ---
    @property
    def local_ip(self) -> str:
        return get_local_ip()

    @property
    def hub_host(self) -> str:
        return self.HUB_HOST or self.local_ip

    @property
    def hub_api_url(self) -> str:
        return f"http://{self.hub_host}:{self.HUB_API_PORT}"

    @property
    def hub_frontend_url(self) -> str:
        return f"http://{self.hub_host}:{self.HUB_FRONTEND_PORT}"

    @property
    def app_host(self) -> str:
        return self.APP_HOST or self.local_ip

    @property
    def is_remote_app(self) -> bool:
        return self.app_host != self.hub_host

    @property
    def api_url(self) -> str:
        return f"http://{self.app_host}:{self.API_PORT}"

    @property
    def frontend_url(self) -> str:
        return f"http://{self.app_host}:{self.FRONTEND_PORT}"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
