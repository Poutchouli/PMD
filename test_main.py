import os
import asyncio
import pytest
import httpx

from app import create_app
from app.services import pinger
from app.services import scheduler as scheduler_service
from app.db import engine
from app.models import Base

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./test_pingmedaddy.db"


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
        response = await ac.post("/targets/", json={"ip": "192.168.1.254", "frequency": 1})
        assert response.status_code == 200
        target_id = response.json()["id"]

        await asyncio.sleep(1.1)

        response = await ac.delete(f"/targets/{target_id}")
        assert response.status_code == 200