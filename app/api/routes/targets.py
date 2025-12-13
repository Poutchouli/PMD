from typing import List
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from app.db import get_db
from app.models import MonitorTarget, PingLog, EventLog
from app.schemas import (
    TargetCreate,
    TargetOut,
    TargetStatus,
    PingLogOut,
    EventLogOut,
    TargetInsights,
    TracerouteResponse,
)
from app.services.scheduler import scheduler
from app.services.stats import compute_target_insights
from app.services import traceroute as traceroute_service
from app.security import require_auth

router = APIRouter(prefix="/targets", tags=["targets"], dependencies=[Depends(require_auth)])


@router.post("/", response_model=TargetStatus)
async def add_target(payload: TargetCreate, db: AsyncSession = Depends(get_db)):
    existing = await db.execute(select(MonitorTarget).where(MonitorTarget.ip_address == str(payload.ip)))
    if existing.scalars().first():
        raise HTTPException(status_code=400, detail="IP already monitored")

    target = MonitorTarget(ip_address=str(payload.ip), frequency=payload.frequency)
    db.add(target)
    await db.commit()
    await db.refresh(target)

    await scheduler.start_for_target(target)
    return TargetStatus(message=f"Started tracking {target.ip_address}", id=target.id)


@router.get("/", response_model=List[TargetOut])
async def list_targets(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(MonitorTarget))
    return [
        TargetOut(
            id=t.id,
            ip=t.ip_address,
            frequency=t.frequency,
            is_active=t.is_active,
            created_at=t.created_at,
        )
        for t in result.scalars().all()
    ]


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
    await db.delete(target)
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


@router.get("/{target_id}/events", response_model=List[EventLogOut])
async def get_events(target_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(EventLog)
        .where(EventLog.target_id == target_id)
        .order_by(EventLog.created_at.desc())
    )
    return result.scalars().all()


@router.get("/{target_id}/insights", response_model=TargetInsights)
async def get_insights(
    target_id: int,
    window_minutes: int = Query(60, ge=1, le=24 * 60),
    bucket_seconds: int = Query(60, ge=10, le=3600),
    db: AsyncSession = Depends(get_db),
):
    data = await compute_target_insights(
        db,
        target_id,
        window_minutes=window_minutes,
        bucket_seconds=bucket_seconds,
    )
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
