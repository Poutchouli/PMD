from typing import List
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from app.db import get_db
from app.models import MonitorTarget, PingLog, EventLog
from app.schemas import TargetCreate, TargetOut, TargetStatus, PingLogOut, EventLogOut
from app.services.scheduler import scheduler

router = APIRouter(prefix="/targets", tags=["targets"])


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
async def stop_target(target_id: int, db: AsyncSession = Depends(get_db)):
    target = await db.get(MonitorTarget, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")
    target.is_active = False
    await db.commit()
    await scheduler.stop_for_target(target_id)
    return TargetStatus(message="Tracking stopped", id=target_id)


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
