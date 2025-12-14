"""Synthetic data loader for PingMeDaddy.

This script generates long-running synthetic ping data so the API behaves as if
it had been tracking several targets for years. It is helpful for manual load
testing, end-to-end aggregation checks, and benchmarking storage usage.
"""

from __future__ import annotations

import argparse
import asyncio
import math
import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from ipaddress import IPv4Address
from pathlib import Path
from typing import List

from sqlalchemy import insert, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import AsyncSessionLocal, engine
from app.models import Base, MonitorTarget, PingLog

DEFAULT_TARGETS = 8
DEFAULT_YEARS = 2.0
DEFAULT_INTERVAL_SECONDS = 60
DEFAULT_LOSS_RATE = 0.02
DEFAULT_CHUNK_SIZE = 10_000
SEED_BASE_IP = IPv4Address("198.18.0.1")


@dataclass
class TargetSpec:
    id: int
    ip: str
    frequency: int
    base_latency: float
    jitter_ms: float
    loss_rate: float
    base_hops: int


async def _reset_schema() -> None:
    async with engine.begin() as conn:
        backend = engine.url.get_backend_name()
        if backend.startswith("postgresql"):
            await conn.execute(text("DROP TABLE IF EXISTS ping_logs CASCADE"))
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)


async def _ensure_schema() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def _prepare_targets(count: int, frequency: int, loss_rate: float, quiet: bool) -> List[TargetSpec]:
    specs: List[TargetSpec] = []
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(MonitorTarget.ip_address))
        existing_ips = set(result.scalars().all())
        base_value = int(SEED_BASE_IP)
        offset = 0
        while len(specs) < count:
            candidate = base_value + offset
            offset += 1
            ip = str(IPv4Address(candidate))
            if ip in existing_ips:
                continue
            existing_ips.add(ip)
            target = MonitorTarget(ip_address=ip, frequency=frequency)
            session.add(target)
            await session.flush()
            base_latency = random.uniform(8.0, 120.0)
            jitter_ms = random.uniform(1.5, 18.0)
            per_target_loss = max(0.0, min(0.2, random.gauss(loss_rate, loss_rate / 2 or 0.005)))
            base_hops = random.randint(3, 18)
            specs.append(
                TargetSpec(
                    id=target.id,
                    ip=ip,
                    frequency=frequency,
                    base_latency=base_latency,
                    jitter_ms=jitter_ms,
                    loss_rate=per_target_loss,
                    base_hops=base_hops,
                )
            )
        await session.commit()
    if not quiet:
        print(f"Created {len(specs)} synthetic targets")
    return specs


async def _flush_chunk(session: AsyncSession, rows: List[dict]) -> int:
    if not rows:
        return 0
    payload = list(rows)
    await session.execute(insert(PingLog), payload)
    await session.commit()
    count = len(payload)
    rows.clear()
    return count


def _simulate_sample(spec: TargetSpec, timestamp: datetime) -> tuple[float | None, int | None, bool]:
    seasonal = math.sin(timestamp.timestamp() / (60 * 60 * 24)) * spec.jitter_ms
    jitter = random.gauss(0, spec.jitter_ms)
    latency = spec.base_latency + seasonal + jitter
    if latency < 0.2:
        latency = 0.2
    if random.random() < spec.loss_rate:
        return None, None, True
    hop_delta = random.choice([-1, 0, 1])
    hops = max(1, spec.base_hops + hop_delta)
    return round(latency, 4), hops, False


async def _seed_target(
    spec: TargetSpec,
    start_ts: datetime,
    samples: int,
    interval_seconds: int,
    chunk_size: int,
    quiet: bool,
) -> int:
    async with AsyncSessionLocal() as session:
        rows: List[dict] = []
        inserted = 0
        timestamp = start_ts
        interval = timedelta(seconds=interval_seconds)
        for _ in range(samples):
            latency, hops, loss = _simulate_sample(spec, timestamp)
            rows.append(
                {
                    "time": timestamp,
                    "target_id": spec.id,
                    "latency_ms": latency,
                    "hops": hops,
                    "packet_loss": loss,
                }
            )
            if len(rows) >= chunk_size:
                inserted += await _flush_chunk(session, rows)
            timestamp += interval
        inserted += await _flush_chunk(session, rows)
    if not quiet:
        print(f"Populated {spec.ip} with {inserted} rows")
    return inserted


def _resolve_db_path() -> Path | None:
    url = make_url(get_settings().database_url)
    if not url.get_backend_name().startswith("sqlite"):
        return None
    if not url.database:
        return None
    db_path = Path(url.database)
    if not db_path.is_absolute():
        db_path = Path.cwd() / db_path
    return db_path


async def _run(args: argparse.Namespace) -> None:
    if args.years <= 0:
        raise SystemExit("--years must be > 0")
    if args.targets <= 0:
        raise SystemExit("--targets must be > 0")
    if args.interval_seconds <= 0:
        raise SystemExit("--interval-seconds must be > 0")
    if args.chunk_size <= 0:
        raise SystemExit("--chunk-size must be > 0")

    if args.seed is not None:
        random.seed(args.seed)

    if args.reset:
        if not args.quiet:
            print("Resetting database schema...")
        await _reset_schema()
    else:
        await _ensure_schema()

    specs = await _prepare_targets(args.targets, args.interval_seconds, args.loss_rate, args.quiet)

    duration = timedelta(days=args.years * 365)
    total_seconds = int(duration.total_seconds())
    samples_per_target = total_seconds // args.interval_seconds
    if total_seconds % args.interval_seconds:
        samples_per_target += 1
    samples_per_target = max(1, samples_per_target)
    start_ts = datetime.now(timezone.utc) - timedelta(seconds=(samples_per_target - 1) * args.interval_seconds)

    if not args.quiet:
        total_samples = samples_per_target * len(specs)
        print(
            f"Generating {samples_per_target} samples per target across {args.years:.2f} years "
            f"(~{total_samples:,} rows)"
        )

    db_path = _resolve_db_path()
    start_size = db_path.stat().st_size if db_path and db_path.exists() else None

    inserted_total = 0
    for spec in specs:
        inserted_total += await _seed_target(
            spec,
            start_ts,
            samples_per_target,
            args.interval_seconds,
            args.chunk_size,
            args.quiet,
        )

    if not args.quiet:
        print(f"Inserted {inserted_total:,} ping rows across {len(specs)} targets")

    if db_path:
        end_size = db_path.stat().st_size if db_path.exists() else 0
        delta = end_size - (start_size or 0)
        print(
            f"SQLite file: {db_path} -> {end_size / (1024 * 1024):.2f} MiB "
            f"(delta {delta / (1024 * 1024):.2f} MiB)"
        )
    else:
        print("Non-SQLite backend detected; disk usage summary unavailable")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate long-running synthetic ping telemetry")
    parser.add_argument("--targets", type=int, default=DEFAULT_TARGETS, help="Number of synthetic targets to create")
    parser.add_argument("--years", type=float, default=DEFAULT_YEARS, help="Years of historical data to backfill")
    parser.add_argument("--interval-seconds", type=int, default=DEFAULT_INTERVAL_SECONDS, help="Seconds between synthetic pings")
    parser.add_argument("--loss-rate", type=float, default=DEFAULT_LOSS_RATE, help="Base packet loss probability per sample")
    parser.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE, help="Bulk insert size for ping logs")
    parser.add_argument("--seed", type=int, default=None, help="Seed for the RNG to make runs reproducible")
    parser.add_argument("--reset", action="store_true", help="Drop and recreate tables before inserting data")
    parser.add_argument("--quiet", action="store_true", help="Suppress detailed progress output")
    return parser


def main() -> int:
    args = _build_parser().parse_args()
    asyncio.run(_run(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
