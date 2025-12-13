import os

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./test_cli.db"
os.environ["CORS_ORIGINS"] = "http://test"

import json
import pytest
import pytest_asyncio

from app import cli  # noqa: E402
from app.services import pinger  # noqa: E402
from app.db import engine  # noqa: E402
from app.models import Base  # noqa: E402


@pytest_asyncio.fixture(autouse=True)
async def reset_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield


def test_cli_ping(monkeypatch, capsys):
    async def fake_ping(ip: str):
        return 12.5, 4, False

    monkeypatch.setattr(pinger, "ping_target", fake_ping)
    code = cli.main(["ping", "8.8.8.8", "--json"])
    assert code == 0

    output = capsys.readouterr().out.strip()
    data = json.loads(output)
    assert data["ip"] == "8.8.8.8"
    assert data["latency_ms"] == 12.5
    assert data["hops"] == 4
    assert data["packet_loss"] is False


def test_cli_target_flow(monkeypatch, capsys):
    async def fake_ping(ip: str):
        return 7.2, 6, False

    monkeypatch.setattr(pinger, "ping_target", fake_ping)

    code = cli.main(["target", "add", "192.168.0.10", "--frequency", "1", "--json"])
    assert code == 0
    output = capsys.readouterr().out.strip()
    created = json.loads(output)
    target_id = created["id"]

    code = cli.main(["target", "list", "--json"])
    assert code == 0
    output = capsys.readouterr().out.strip()
    targets = json.loads(output)
    assert any(t["id"] == target_id for t in targets)

    code = cli.main(["target", "pause", str(target_id)])
    assert code == 0
    _ = capsys.readouterr()

    code = cli.main(["target", "resume", str(target_id)])
    assert code == 0
    _ = capsys.readouterr()

    code = cli.main(["target", "events", str(target_id), "--json"])
    assert code == 0
    output = capsys.readouterr().out.strip()
    events = json.loads(output)
    assert any(e["event_type"] == "start" for e in events)
    assert any(e["event_type"] == "stop" for e in events)

    code = cli.main(["target", "delete", str(target_id)])
    assert code == 0
    _ = capsys.readouterr()

    code = cli.main(["target", "events", str(target_id), "--json"])
    assert code == 0
    output = capsys.readouterr().out.strip()
    events = json.loads(output)
    assert any(e["event_type"] == "stop" for e in events)
