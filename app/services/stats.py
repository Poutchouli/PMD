from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from statistics import mean
from typing import Dict, List, Optional

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import MonitorTarget, PingLog

DEFAULT_WINDOW_MINUTES = 60
DEFAULT_BUCKET_SECONDS = 60
# Higher cap to support multi-day windows without dropping samples too early.
MAX_SAMPLES = 20000


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


def _ensure_aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _use_continuous_aggregate(bucket_seconds: int) -> Optional[str]:
    """Decide which continuous aggregate to use based on bucket size.
    
    Returns table name or None if raw ping_logs should be used.
    """
    # Use ping_hour for buckets >= 1 hour
    if bucket_seconds >= 3600:
        return "ping_hour"
    # Use ping_minute for buckets >= 1 minute
    if bucket_seconds >= 60:
        return "ping_minute"
    # Sub-minute buckets need raw data
    return None


async def _query_from_aggregate(
    db: AsyncSession,
    target_id: int,
    source_table: str,
    bucket_seconds: int,
    window_start: datetime,
    window_end: datetime,
):
    """Query pre-aggregated data from continuous aggregates for fast results."""
    # Re-bucket to requested size using time_bucket on top of the aggregate
    query = text(f"""
        SELECT 
            time_bucket(:bucket_secs * INTERVAL '1 second', bucket) AS bucket,
            SUM(samples)::bigint AS sample_count,
            SUM(loss_count)::bigint AS loss_count,
            SUM(avg_latency * samples) / NULLIF(SUM(samples), 0) AS avg_latency,
            MIN(min_latency) AS min_latency,
            MAX(max_latency) AS max_latency
        FROM {source_table}
        WHERE target_id = :target_id
          AND bucket >= :start_time AND bucket < :end_time
        GROUP BY 1
        ORDER BY 1
    """)
    
    result = await db.execute(query, {
        "target_id": target_id,
        "bucket_secs": bucket_seconds,
        "start_time": window_start,
        "end_time": window_end,
    })
    return result.fetchall()


async def _query_from_raw(
    db: AsyncSession,
    target_id: int,
    bucket_seconds: int,
    window_start: datetime,
    window_end: datetime,
    max_samples: int,
):
    """Fall back to raw ping_logs for sub-minute resolution or recent data."""
    stmt = (
        select(PingLog)
        .where(PingLog.target_id == target_id)
        .where(PingLog.time >= window_start)
        .where(PingLog.time <= window_end)
        .order_by(PingLog.time.desc())
        .limit(max_samples)
    )
    result = await db.execute(stmt)
    logs = list(result.scalars().all())

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

    return logs, timeline_map


async def compute_target_insights(
    db: AsyncSession,
    target_id: int,
    *,
    window_minutes: int = DEFAULT_WINDOW_MINUTES,
    bucket_seconds: int = DEFAULT_BUCKET_SECONDS,
    max_samples: int = MAX_SAMPLES,
    window_start: Optional[datetime] = None,
    window_end: Optional[datetime] = None,
):
    target = await db.get(MonitorTarget, target_id)
    if not target:
        return None

    window_minutes = max(1, window_minutes)
    bucket_seconds = max(10, bucket_seconds)
    max_samples = max(100, max_samples)

    resolved_end = _ensure_aware(window_end) if window_end else datetime.now(timezone.utc)
    resolved_start = _ensure_aware(window_start) if window_start else resolved_end - timedelta(minutes=window_minutes)
    if resolved_start >= resolved_end:
        raise ValueError("window_start must be before window_end")

    window_start = resolved_start
    window_end = resolved_end
    window_minutes = max(1, int((window_end - window_start).total_seconds() // 60))

    # Use continuous aggregates for faster queries when possible
    source_table = _use_continuous_aggregate(bucket_seconds)
    
    if source_table:
        # Fast path: query from pre-aggregated continuous aggregates
        rows = await _query_from_aggregate(
            db, target_id, source_table, bucket_seconds, window_start, window_end
        )
        
        total_samples = sum(row.sample_count or 0 for row in rows)
        loss_count = sum(row.loss_count or 0 for row in rows)
        
        # Build timeline from aggregate rows
        timeline = []
        all_avg_latencies = []
        min_latency = None
        max_latency = None
        
        for row in rows:
            if row.avg_latency is not None:
                all_avg_latencies.append(row.avg_latency)
            if row.min_latency is not None:
                if min_latency is None or row.min_latency < min_latency:
                    min_latency = row.min_latency
            if row.max_latency is not None:
                if max_latency is None or row.max_latency > max_latency:
                    max_latency = row.max_latency
            
            loss_rate = 0.0
            if row.sample_count:
                loss_rate = (row.loss_count or 0) / row.sample_count
            
            timeline.append({
                "bucket": row.bucket,
                "avg_latency_ms": row.avg_latency,
                "min_latency_ms": row.min_latency,
                "max_latency_ms": row.max_latency,
                "loss_rate": loss_rate,
                "sample_count": row.sample_count or 0,
            })
        
        uptime_percent = None
        if total_samples:
            uptime_percent = (1 - (loss_count / total_samples)) * 100
        
        avg_latency = mean(all_avg_latencies) if all_avg_latencies else None
        
        # Percentiles approximated from bucket averages (less accurate but fast)
        sorted_avgs = sorted(all_avg_latencies) if all_avg_latencies else []
        
        insights = {
            "target_id": target.id,
            "target_ip": target.ip_address,
            "created_at": target.created_at,
            "window_minutes": window_minutes,
            "sample_count": total_samples,
            "loss_count": loss_count,
            "uptime_percent": uptime_percent,
            "latency_avg_ms": avg_latency,
            "latency_min_ms": min_latency,
            "latency_max_ms": max_latency,
            "latency_p50_ms": _percentile(sorted_avgs, 0.5),
            "latency_p95_ms": _percentile(sorted_avgs, 0.95),
            "latency_p99_ms": _percentile(sorted_avgs, 0.99),
            "timeline": timeline,
            "window_start": window_start,
            "window_end": window_end,
        }
        return insights
    
    # Slow path: query raw ping_logs for sub-minute resolution
    logs, timeline_map = await _query_from_raw(
        db, target_id, bucket_seconds, window_start, window_end, max_samples
    )

    total_samples = len(logs)
    loss_count = sum(1 for log in logs if log.packet_loss)
    valid_latencies = sorted(
        [log.latency_ms for log in logs if not log.packet_loss and log.latency_ms is not None]
    )

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
