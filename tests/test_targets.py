import os
import asyncio
from datetime import datetime, timezone

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./test_pingmedaddy.db"
os.environ["ADMIN_USERNAME"] = "admin"
os.environ["ADMIN_PASSWORD"] = "changeme"
os.environ["AUTH_SECRET"] = "test-secret"
os.environ["CORS_ORIGINS"] = "http://test"

import pytest
import httpx

from app.config import get_settings  # noqa: E402
get_settings.cache_clear()
from app import create_app  # noqa: E402
from app.services import pinger  # noqa: E402
from app.services import scheduler as scheduler_service  # noqa: E402
from app.services import traceroute as traceroute_service  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import Base  # noqa: E402

@pytest.mark.asyncio
async def test_create_pause_resume_flow(monkeypatch):
    async def fake_ping(ip: str):
        return 10.0, 5, False

    monkeypatch.setattr(pinger, "ping_target", fake_ping)
    monkeypatch.setattr(scheduler_service, "ping_target", fake_ping)

    async def fake_traceroute(ip: str, **_kwargs):
        now = datetime.now(timezone.utc)
        return {
            "ip": ip,
            "started_at": now,
            "finished_at": now,
            "duration_ms": 1.0,
            "hops": [
                {
                    "hop": 1,
                    "host": "router",
                    "ip": "192.168.0.1",
                    "rtt_ms": 1.0,
                    "is_timeout": False,
                    "raw": "1 router (192.168.0.1) 1.0 ms",
                }
            ],
        }

    monkeypatch.setattr(traceroute_service, "run_traceroute", fake_traceroute)
    await scheduler_service.scheduler.shutdown()

    app = create_app()
    transport = httpx.ASGITransport(app=app)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        login_resp = await client.post(
            "/auth/login",
            json={"username": os.environ["ADMIN_USERNAME"], "password": os.environ["ADMIN_PASSWORD"]},
        )
        assert login_resp.status_code == 200
        token = login_resp.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        resp = await client.post(
            "/targets/", json={"ip": "192.168.1.254", "frequency": 1}, headers=headers
        )
        assert resp.status_code == 200
        target_id = resp.json()["id"]

        resp = await client.patch(
            f"/targets/{target_id}",
            json={"notes": "Router salle serveur", "url": "https://router.example"},
            headers=headers,
        )
        assert resp.status_code == 200
        updated = resp.json()
        assert updated["notes"] == "Router salle serveur"
        assert updated["url"].startswith("https://router.example")

        resp = await client.patch(
            f"/targets/{target_id}",
            json={"notes": ""},
            headers=headers,
        )
        assert resp.status_code == 200
        updated = resp.json()
        assert updated["notes"] is None

        await asyncio.sleep(1.1)

        resp = await client.post(f"/targets/{target_id}/pause", headers=headers)
        assert resp.status_code == 200

        resp = await client.post(f"/targets/{target_id}/resume", headers=headers)
        assert resp.status_code == 200

        resp = await client.get(
            f"/targets/{target_id}/logs", params={"limit": 10}, headers=headers
        )
        assert resp.status_code == 200
        logs = resp.json()
        assert len(logs) >= 1
        assert logs[-1]["latency_ms"] == 10.0

        resp = await client.get(
            f"/targets/{target_id}/logs/export",
            headers=headers,
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/csv")
        csv_body = resp.text.strip().splitlines()
        assert csv_body[0].startswith("time,target_id,target_ip")
        assert len(csv_body) >= 2

        resp = await client.get("/targets/import/template", headers=headers)
        assert resp.status_code == 200
        template_lines = resp.text.strip().splitlines()
        assert template_lines[0] == "ip,frequency,url,notes,is_active"

        csv_payload = """ip,frequency,url,notes,is_active
10.0.0.1,5,https://edge.local,Edge router,true
192.168.1.254,5,,,false
"""
        resp = await client.post(
            "/targets/import",
            headers=headers,
            files={"file": ("targets.csv", csv_payload, "text/csv")},
        )
        assert resp.status_code == 200
        import_result = resp.json()
        assert import_result["created"] == 1
        assert import_result["skipped_existing"] == 1
        assert import_result["row_count"] == 2
        assert import_result["errors"] == []

        resp = await client.get("/targets/export", headers=headers)
        assert resp.status_code == 200
        export_lines = resp.text.strip().splitlines()
        assert export_lines[0] == "ip,frequency,url,notes,is_active"
        assert any(line.startswith("10.0.0.1,5") for line in export_lines[1:])

        resp = await client.get(f"/targets/{target_id}/events", headers=headers)
        assert resp.status_code == 200
        events = resp.json()
        assert any(e["event_type"] == "start" for e in events)

        resp = await client.get(
            f"/targets/{target_id}/insights",
            headers=headers,
        )
        assert resp.status_code == 200
        insights = resp.json()
        assert insights["target_id"] == target_id

        resp = await client.post(
            f"/targets/{target_id}/traceroute",
            headers=headers,
        )
        assert resp.status_code == 200
        trace = resp.json()
        assert trace["hops"][0]["hop"] == 1

        resp = await client.delete(f"/targets/{target_id}", headers=headers)
        assert resp.status_code == 200

        resp = await client.get("/targets/", headers=headers)
        assert resp.status_code == 200
        targets = resp.json()
        assert all(t["id"] != target_id for t in targets)
