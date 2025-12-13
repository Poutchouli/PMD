import os

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./test_pingmedaddy.db"
os.environ["ADMIN_USERNAME"] = "admin"
os.environ["ADMIN_PASSWORD"] = "changeme"
os.environ["AUTH_SECRET"] = "test-secret"
os.environ["CORS_ORIGINS"] = "http://test"

import asyncio
import pytest
import httpx

from app.config import get_settings
from app import create_app
from app.services import pinger
from app.services import scheduler as scheduler_service
from app.db import engine
from app.models import Base

get_settings.cache_clear()


@pytest.mark.asyncio
async def test_create_and_track_gateway(monkeypatch):
    async def fake_ping(ip: str):
        return 15.0, 6, False

    monkeypatch.setattr(pinger, "ping_target", fake_ping)
    monkeypatch.setattr(scheduler_service, "ping_target", fake_ping)
    await scheduler_service.scheduler.shutdown()
    app = create_app()
    transport = httpx.ASGITransport(app=app)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        login = await ac.post(
            "/auth/login",
            json={"username": os.getenv("ADMIN_USERNAME", "admin"), "password": os.getenv("ADMIN_PASSWORD", "changeme")},
        )
        assert login.status_code == 200
        token = login.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        response = await ac.post(
            "/targets/", json={"ip": "192.168.1.254", "frequency": 1}, headers=headers
        )
        assert response.status_code == 200
        target_id = response.json()["id"]

        await asyncio.sleep(1.1)

        response = await ac.delete(f"/targets/{target_id}", headers=headers)
        assert response.status_code == 200