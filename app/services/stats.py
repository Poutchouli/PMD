from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from statistics import mean
from typing import Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import MonitorTarget, PingLog

DEFAULT_WINDOW_MINUTES = 60
DEFAULT_BUCKET_SECONDS = 60
MAX_SAMPLES = 5000


def _floor_to_bucket(timestamp: datetime, bucket_seconds: int) -> datetime:
    seconds = int(timestamp.timestamp())
    floored = seconds - (seconds % bucket_seconds)
    return datetime.fromtimestamp(floored, tz=timezone.utc)


def _percentile(sorted_values: List[float], percentile: float) -> Optional[float]:
    if not sorted_values:
        return None
    if percentile <= 0:
        return sorted_values[0]
    if percentile >= 1:
        return sorted_values[-1]
    k = (len(sorted_values) - 1) * percentile
    lower_index = int(k)
    upper_index = min(lower_index + 1, len(sorted_values) - 1)
    weight = k - lower_index
    lower = sorted_values[lower_index]
    upper = sorted_values[upper_index]
    return lower + (upper - lower) * weight


@dataclass
class TimelineBucket:
    bucket: datetime
    latencies: List[float]
    loss_count: int
    sample_count: int

    @property
    def avg_latency(self) -> Optional[float]:
        return mean(self.latencies) if self.latencies else None

    @property
    def min_latency(self) -> Optional[float]:
        return min(self.latencies) if self.latencies else None

    @property
    def max_latency(self) -> Optional[float]:
        return max(self.latencies) if self.latencies else None

    @property
    def loss_rate(self) -> float:
        if self.sample_count == 0:
            return 0.0
        return self.loss_count / self.sample_count


async def compute_target_insights(
    db: AsyncSession,
    target_id: int,
    *,
    window_minutes: int = DEFAULT_WINDOW_MINUTES,
    bucket_seconds: int = DEFAULT_BUCKET_SECONDS,
    max_samples: int = MAX_SAMPLES,
):
    target = await db.get(MonitorTarget, target_id)
    if not target:
        return None

    window_minutes = max(1, window_minutes)
    bucket_seconds = max(10, bucket_seconds)
    max_samples = max(100, max_samples)

    window_end = datetime.now(timezone.utc)
    window_start = window_end - timedelta(minutes=window_minutes)

    stmt = (
        select(PingLog)
        .where(PingLog.target_id == target_id)
        .where(PingLog.time >= window_start)
        .order_by(PingLog.time.desc())
        .limit(max_samples)
    )
    result = await db.execute(stmt)
    logs = list(result.scalars().all())

    total_samples = len(logs)
    loss_count = sum(1 for log in logs if log.packet_loss)
    valid_latencies = sorted(
        [log.latency_ms for log in logs if not log.packet_loss and log.latency_ms is not None]
    )

    timeline_map: Dict[datetime, TimelineBucket] = {}
    for log in logs:
        bucket = _floor_to_bucket(log.time.astimezone(timezone.utc), bucket_seconds)
        if bucket not in timeline_map:
            timeline_map[bucket] = TimelineBucket(bucket=bucket, latencies=[], loss_count=0, sample_count=0)
        entry = timeline_map[bucket]
        entry.sample_count += 1
        if log.packet_loss or log.latency_ms is None:
            entry.loss_count += 1
        else:
            entry.latencies.append(log.latency_ms)

    timeline = [
        {
            "bucket": bucket.bucket,
            "avg_latency_ms": bucket.avg_latency,
            "min_latency_ms": bucket.min_latency,
            "max_latency_ms": bucket.max_latency,
            "loss_rate": bucket.loss_rate,
            "sample_count": bucket.sample_count,
        }
        for bucket in sorted(timeline_map.values(), key=lambda b: b.bucket)
    ]

    uptime_percent = None
    if total_samples:
        uptime_percent = (1 - (loss_count / total_samples)) * 100

    insights = {
        "target_id": target.id,
        "target_ip": target.ip_address,
        "created_at": target.created_at,
        "window_minutes": window_minutes,
        "sample_count": total_samples,
        "loss_count": loss_count,
        "uptime_percent": uptime_percent,
        "latency_avg_ms": mean(valid_latencies) if valid_latencies else None,
        "latency_min_ms": valid_latencies[0] if valid_latencies else None,
        "latency_max_ms": valid_latencies[-1] if valid_latencies else None,
        "latency_p50_ms": _percentile(valid_latencies, 0.5),
        "latency_p95_ms": _percentile(valid_latencies, 0.95),
        "latency_p99_ms": _percentile(valid_latencies, 0.99),
        "timeline": timeline,
        "window_start": window_start,
        "window_end": window_end,
    }
    return insights
