import os
import asyncio
import pytest
import httpx

# Ensure test DB before imports
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./test_pingmedaddy.db"

from app import create_app  # noqa: E402
from app.services import pinger  # noqa: E402
from app.services import scheduler as scheduler_service  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import Base  # noqa: E402


@pytest.mark.asyncio
async def test_create_pause_resume_flow(monkeypatch):
    async def fake_ping(ip: str):
        return 10.0, 5, False

    monkeypatch.setattr(pinger, "ping_target", fake_ping)
    monkeypatch.setattr(scheduler_service, "ping_target", fake_ping)
    await scheduler_service.scheduler.shutdown()

    app = create_app()
    transport = httpx.ASGITransport(app=app)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/targets/", json={"ip": "192.168.1.254", "frequency": 1})
        assert resp.status_code == 200
        target_id = resp.json()["id"]

        await asyncio.sleep(1.1)

        resp = await client.post(f"/targets/{target_id}/pause")
        assert resp.status_code == 200

        resp = await client.post(f"/targets/{target_id}/resume")
        assert resp.status_code == 200

        resp = await client.get(f"/targets/{target_id}/logs", params={"limit": 10})
        assert resp.status_code == 200
        logs = resp.json()
        assert len(logs) >= 1
        assert logs[-1]["latency_ms"] == 10.0

        resp = await client.get(f"/targets/{target_id}/events")
        assert resp.status_code == 200
        events = resp.json()
        assert any(e["event_type"] == "start" for e in events)

        resp = await client.delete(f"/targets/{target_id}")
        assert resp.status_code == 200
