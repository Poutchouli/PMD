from __future__ import annotations

from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from app.db import get_db
from app.models import TargetGroup, MonitorTarget
from app.schemas import GroupCreate, GroupOut, GroupUpdate
from app.hub_auth import get_current_user

router = APIRouter(prefix="/groups", tags=["groups"], dependencies=[Depends(get_current_user)])


def _to_group_out(group: TargetGroup, target_count: int = 0) -> GroupOut:
    return GroupOut(
        id=group.id,
        name=group.name,
        color=group.color,
        target_count=target_count,
        created_at=group.created_at,
    )


@router.get("/", response_model=List[GroupOut])
async def list_groups(db: AsyncSession = Depends(get_db)):
    stmt = (
        select(TargetGroup, func.count(MonitorTarget.id).label("target_count"))
        .outerjoin(MonitorTarget, MonitorTarget.group_id == TargetGroup.id)
        .group_by(TargetGroup.id)
        .order_by(TargetGroup.name.asc())
    )
    result = await db.execute(stmt)
    return [_to_group_out(row[0], row[1]) for row in result.all()]


@router.post("/", response_model=GroupOut, status_code=201)
async def create_group(payload: GroupCreate, db: AsyncSession = Depends(get_db)):
    existing = await db.execute(select(TargetGroup).where(TargetGroup.name == payload.name))
    if existing.scalars().first():
        raise HTTPException(status_code=400, detail="Group name already exists")

    group = TargetGroup(name=payload.name, color=payload.color)
    db.add(group)
    await db.commit()
    await db.refresh(group)
    return _to_group_out(group, 0)


@router.patch("/{group_id}", response_model=GroupOut)
async def update_group(group_id: int, payload: GroupUpdate, db: AsyncSession = Depends(get_db)):
    group = await db.get(TargetGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    if payload.name is not None:
        dup = await db.execute(
            select(TargetGroup).where(TargetGroup.name == payload.name, TargetGroup.id != group_id)
        )
        if dup.scalars().first():
            raise HTTPException(status_code=400, detail="Group name already exists")
        group.name = payload.name

    if payload.color is not None:
        group.color = payload.color

    await db.commit()
    await db.refresh(group)

    count_result = await db.execute(
        select(func.count(MonitorTarget.id)).where(MonitorTarget.group_id == group_id)
    )
    target_count = count_result.scalar() or 0
    return _to_group_out(group, target_count)


@router.delete("/{group_id}")
async def delete_group(group_id: int, db: AsyncSession = Depends(get_db)):
    group = await db.get(TargetGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    await db.delete(group)
    await db.commit()
    return {"detail": "Group deleted", "id": group_id}
