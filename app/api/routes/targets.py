from __future__ import annotations

import csv
import ipaddress
from datetime import datetime, timezone
from io import StringIO
from typing import List
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from pydantic import ValidationError

from app.db import get_db
from app.models import MonitorTarget, PingLog, EventLog
from app.schemas import (
    TargetCreate,
    TargetOut,
    TargetStatus,
    TargetUpdate,
    PingLogOut,
    EventLogOut,
    TargetInsights,
    TracerouteResponse,
    TargetImportResult,
    TargetImportRow,
)
from app.services.scheduler import scheduler
from app.services.stats import MAX_SAMPLES, compute_target_insights
from app.services import traceroute as traceroute_service
from app.security import require_auth

router = APIRouter(prefix="/targets", tags=["targets"], dependencies=[Depends(require_auth)])

TARGET_CSV_FIELDS = ["ip", "frequency", "url", "notes", "is_active"]


def _to_target_out(target: MonitorTarget) -> TargetOut:
    return TargetOut(
        id=target.id,
        ip=target.ip_address,
        frequency=target.frequency,
        is_active=target.is_active,
        created_at=target.created_at,
        url=target.display_url,
        notes=target.notes,
    )


@router.get("/import/template")
async def download_import_template():
    """Provide a CSV template with editable fields for bulk imports."""

    def rows():
        buffer = StringIO()
        writer = csv.writer(buffer)
        writer.writerow(TARGET_CSV_FIELDS)
        writer.writerow(["192.0.2.10", 5, "https://router.local", "Edge router", True])
        writer.writerow(["198.51.100.8", 30, "", "Backup link", False])
        yield buffer.getvalue()

    headers = {"Content-Disposition": "attachment; filename=pingmedaddy-targets-template.csv"}
    return StreamingResponse(rows(), media_type="text/csv", headers=headers)


@router.get("/export")
async def export_targets(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(MonitorTarget).order_by(MonitorTarget.id.asc()))
    targets = result.scalars().all()

    async def csv_rows():
        buffer = StringIO()
        writer = csv.writer(buffer)
        writer.writerow(TARGET_CSV_FIELDS)
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)
        for target in targets:
            writer.writerow(
                [
                    target.ip_address,
                    target.frequency,
                    target.display_url or "",
                    target.notes or "",
                    target.is_active,
                ]
            )
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)

    headers = {"Content-Disposition": "attachment; filename=pingmedaddy-targets.csv"}
    return StreamingResponse(csv_rows(), media_type="text/csv", headers=headers)


@router.post("/import", response_model=TargetImportResult)
async def import_targets(file: UploadFile = File(...), db: AsyncSession = Depends(get_db)):
    content = await file.read()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:  # pragma: no cover - defensive
        raise HTTPException(status_code=400, detail="CSV must be UTF-8 encoded") from exc

    reader = csv.DictReader(StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV header is required")

    normalized_headers = [h.strip().lower() for h in reader.fieldnames if h]
    missing = [field for field in TARGET_CSV_FIELDS if field not in normalized_headers]
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing columns: {', '.join(missing)}")

    existing_ips_result = await db.execute(select(MonitorTarget.ip_address))
    existing_ips = {ip for (ip,) in existing_ips_result.all()}

    created_targets: List[MonitorTarget] = []
    skipped_existing = 0
    errors: List[str] = []

    def normalize_row(row: dict) -> dict:
        normalized = {}
        for key, value in row.items():
            if key is None:
                continue
            normalized[key.strip().lower()] = (value or "").strip()
        return normalized

    def parse_bool(value: str) -> bool:
        if value is None:
            return True
        lowered = value.strip().lower()
        if lowered in {"false", "0", "no", "n"}:
            return False
        if lowered in {"true", "1", "yes", "y", "on"}:
            return True
        return True

    row_count = 0
    for idx, raw in enumerate(reader, start=2):
        row_count += 1
        data = normalize_row(raw)
        payload = {
            "ip": data.get("ip"),
            "frequency": data.get("frequency") or 1,
            "url": data.get("url"),
            "notes": data.get("notes"),
            "is_active": parse_bool(data.get("is_active", "true")),
        }
        if not payload["ip"]:
            errors.append(f"Row {idx}: ip is required")
            continue
        try:
            payload["ip"] = str(ipaddress.ip_address(payload["ip"]))
        except ValueError:
            errors.append(f"Row {idx}: invalid IP {payload['ip']}")
            continue
        if payload["ip"] in existing_ips or any(t.ip_address == payload["ip"] for t in created_targets):
            skipped_existing += 1
            continue
        try:
            parsed = TargetImportRow(**payload)
        except ValidationError as exc:
            msg = "; ".join(err.get("msg", "invalid data") for err in exc.errors())
            errors.append(f"Row {idx}: {msg}")
            continue

        target = MonitorTarget(
            ip_address=str(parsed.ip),
            frequency=parsed.frequency,
            display_url=str(parsed.url) if parsed.url else None,
            notes=parsed.notes,
            is_active=parsed.is_active,
        )
        db.add(target)
        created_targets.append(target)

    await db.commit()
    for target in created_targets:
        await db.refresh(target)
        if target.is_active:
            await scheduler.start_for_target(target)

    return TargetImportResult(
        row_count=row_count,
        created=len(created_targets),
        skipped_existing=skipped_existing,
        errors=errors,
    )


@router.post("/", response_model=TargetStatus)
async def add_target(payload: TargetCreate, db: AsyncSession = Depends(get_db)):
    existing = await db.execute(select(MonitorTarget).where(MonitorTarget.ip_address == str(payload.ip)))
    if existing.scalars().first():
        raise HTTPException(status_code=400, detail="IP already monitored")

    target = MonitorTarget(
        ip_address=str(payload.ip),
        frequency=payload.frequency,
        display_url=str(payload.url) if payload.url else None,
        notes=payload.notes,
    )
    db.add(target)
    await db.commit()
    await db.refresh(target)

    await scheduler.start_for_target(target)
    return TargetStatus(message=f"Started tracking {target.ip_address}", id=target.id)


@router.get("/", response_model=List[TargetOut])
async def list_targets(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(MonitorTarget))
    return [_to_target_out(t) for t in result.scalars().all()]


@router.patch("/{target_id}", response_model=TargetOut)
async def update_target(target_id: int, payload: TargetUpdate, db: AsyncSession = Depends(get_db)):
    target = await db.get(MonitorTarget, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")

    if "frequency" in payload.model_fields_set:
        target.frequency = payload.frequency if payload.frequency is not None else target.frequency

    if "url" in payload.model_fields_set:
        target.display_url = str(payload.url) if payload.url else None

    if "notes" in payload.model_fields_set:
        target.notes = payload.notes

    await db.commit()
    await db.refresh(target)
    return _to_target_out(target)


@router.post("/{target_id}/pause", response_model=TargetStatus)
async def pause_target(target_id: int, db: AsyncSession = Depends(get_db)):
    target = await db.get(MonitorTarget, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")
    target.is_active = False
    await db.commit()
    await scheduler.stop_for_target(target_id, "Tracking paused")
    return TargetStatus(message="Tracking paused", id=target_id)


@router.post("/{target_id}/resume", response_model=TargetStatus)
async def resume_target(target_id: int, db: AsyncSession = Depends(get_db)):
    target = await db.get(MonitorTarget, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")
    target.is_active = True
    await db.commit()
    await scheduler.start_for_target(target)
    return TargetStatus(message="Tracking resumed", id=target_id)


@router.delete("/{target_id}", response_model=TargetStatus)
async def delete_target(target_id: int, db: AsyncSession = Depends(get_db)):
    target = await db.get(MonitorTarget, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")
    await scheduler.stop_for_target(target_id, "Tracking stopped and target deleted")
    await db.execute(delete(PingLog).where(PingLog.target_id == target_id))
    await db.execute(delete(EventLog).where(EventLog.target_id == target_id))
    await db.execute(delete(MonitorTarget).where(MonitorTarget.id == target_id))
    await db.commit()
    return TargetStatus(message="Target deleted", id=target_id)


@router.get("/{target_id}/logs", response_model=List[PingLogOut])
async def get_logs(
    target_id: int,
    limit: int = Query(100, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(PingLog)
        .where(PingLog.target_id == target_id)
        .order_by(PingLog.time.desc())
        .limit(limit)
    )
    return list(reversed(result.scalars().all()))


@router.get("/{target_id}/logs/export")
async def export_logs(target_id: int, db: AsyncSession = Depends(get_db)):
    target = await db.get(MonitorTarget, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")

    stmt = (
        select(PingLog)
        .where(PingLog.target_id == target_id)
        .order_by(PingLog.time.asc())
    )
    result = await db.stream(stmt)

    async def csv_rows():
        buffer = StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["time", "target_id", "target_ip", "latency_ms", "hops", "packet_loss"])
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)
        async for log in result.scalars():
            writer.writerow(
                [
                    log.time.isoformat(),
                    log.target_id,
                    target.ip_address,
                    "" if log.latency_ms is None else log.latency_ms,
                    "" if log.hops is None else log.hops,
                    int(bool(log.packet_loss)),
                ]
            )
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)

    filename = f"pingmedaddy-target-{target.id}-logs.csv"
    headers = {"Content-Disposition": f"attachment; filename={filename}"}
    return StreamingResponse(csv_rows(), media_type="text/csv", headers=headers)


@router.get("/{target_id}/events", response_model=List[EventLogOut])
async def get_events(
    target_id: int,
    start: datetime | None = Query(None, description="Start of the range (inclusive)"),
    end: datetime | None = Query(None, description="End of the range (inclusive)"),
    limit: int = Query(500, ge=1, le=5_000, description="Maximum number of events to return"),
    db: AsyncSession = Depends(get_db),
):
    if start and start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end and end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    if start and end and start >= end:
        raise HTTPException(status_code=400, detail="start must be before end")

    stmt = select(EventLog).where(EventLog.target_id == target_id)
    if start:
        stmt = stmt.where(EventLog.created_at >= start)
    if end:
        stmt = stmt.where(EventLog.created_at <= end)
    stmt = stmt.order_by(EventLog.created_at.desc()).limit(limit)

    result = await db.execute(stmt)
    events = list(result.scalars().all())
    return list(reversed(events))


@router.get("/{target_id}/insights", response_model=TargetInsights)
async def get_insights(
    target_id: int,
    window_minutes: int = Query(60, ge=1, le=24 * 60 * 30),
    bucket_seconds: int = Query(60, ge=10, le=21_600),
    start: datetime | None = Query(None, description="Start of the window (UTC). Overrides window_minutes when set."),
    end: datetime | None = Query(None, description="End of the window (UTC). Overrides window_minutes when set."),
    max_samples: int = Query(MAX_SAMPLES, ge=100, le=MAX_SAMPLES),
    db: AsyncSession = Depends(get_db),
):
    if start and start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end and end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    if start and end and start >= end:
        raise HTTPException(status_code=400, detail="start must be before end")

    try:
        data = await compute_target_insights(
            db,
            target_id,
            window_minutes=window_minutes,
            bucket_seconds=bucket_seconds,
            window_start=start,
            window_end=end,
            max_samples=max_samples,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not data:
        raise HTTPException(status_code=404, detail="Target not found")
    return TargetInsights(**data)


@router.post("/{target_id}/traceroute", response_model=TracerouteResponse)
async def trigger_traceroute(
    target_id: int,
    max_hops: int = Query(20, ge=1, le=64),
    timeout: float = Query(25.0, ge=1.0, le=120.0),
    db: AsyncSession = Depends(get_db),
):
    target = await db.get(MonitorTarget, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")
    try:
        result = await traceroute_service.run_traceroute(
            target.ip_address,
            max_hops=max_hops,
            timeout=timeout,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return TracerouteResponse(
        target_id=target.id,
        target_ip=target.ip_address,
        started_at=result["started_at"],
        finished_at=result["finished_at"],
        duration_ms=result["duration_ms"],
        hops=result.get("hops", []),
    )
