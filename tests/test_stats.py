import os

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./test_stats.db"
os.environ.setdefault("CORS_ORIGINS", "http://test")

import math
import statistics
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import insert

from app.config import get_settings

get_settings.cache_clear()

from app.db import AsyncSessionLocal, engine
from app.models import Base, MonitorTarget, PingLog
from app.services.stats import compute_target_insights


def _percentile(values, percentile):
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * percentile
    lower = math.floor(k)
    upper = min(lower + 1, len(ordered) - 1)
    weight = k - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * weight


@pytest.mark.asyncio
async def test_insights_focus_on_recent_window():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as session:
        target = MonitorTarget(ip_address="198.18.0.99", frequency=60)
        session.add(target)
        await session.commit()
        await session.refresh(target)

        now = datetime.now(timezone.utc)
        old_start = now - timedelta(days=900)
        old_rows = []
        timestamp = old_start
        old_interval = timedelta(hours=6)
        for _ in range(900 * 4):
            old_rows.append(
                {
                    "time": timestamp,
                    "target_id": target.id,
                    "latency_ms": 42.0,
                    "hops": 9,
                    "packet_loss": False,
                }
            )
            timestamp += old_interval
        await session.execute(insert(PingLog), old_rows)
        await session.commit()

        recent_start = now - timedelta(hours=24)
        interval = timedelta(minutes=15)
        recent_rows = []
        recent_latencies = []
        timestamp = recent_start
        for idx in range(96):
            latency = round(20.0 + math.sin(idx / 10.0) * 5.0, 4)
            recent_latencies.append(latency)
            recent_rows.append(
                {
                    "time": timestamp,
                    "target_id": target.id,
                    "latency_ms": latency,
                    "hops": 6 + (idx % 3),
                    "packet_loss": False,
                }
            )
            timestamp += interval
        await session.execute(insert(PingLog), recent_rows)
        await session.commit()

    async with AsyncSessionLocal() as session:
        insights = await compute_target_insights(
            session,
            target.id,
            window_minutes=24 * 60,
            bucket_seconds=900,
            max_samples=10_000,
        )

    assert insights is not None
    assert insights["sample_count"] == len(recent_latencies)
    assert insights["loss_count"] == 0
    assert insights["uptime_percent"] == pytest.approx(100.0)
    assert insights["latency_min_ms"] == min(recent_latencies)
    assert insights["latency_max_ms"] == max(recent_latencies)
    assert insights["latency_avg_ms"] == pytest.approx(statistics.mean(recent_latencies), rel=1e-6)
    assert insights["latency_p50_ms"] == pytest.approx(statistics.median(recent_latencies), rel=1e-6)
    assert insights["latency_p95_ms"] == pytest.approx(_percentile(recent_latencies, 0.95), rel=1e-6)
    assert insights["latency_p99_ms"] == pytest.approx(_percentile(recent_latencies, 0.99), rel=1e-6)

    timeline = insights["timeline"]
    assert len(timeline) == len(recent_latencies)
    assert timeline[0]["sample_count"] == 1
    assert timeline[-1]["sample_count"] == 1
    assert timeline[0]["min_latency_ms"] == pytest.approx(recent_latencies[0], rel=1e-6)
    assert timeline[-1]["max_latency_ms"] == pytest.approx(recent_latencies[-1], rel=1e-6)
*** End Patch