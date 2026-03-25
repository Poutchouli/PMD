"""
Routes de préférences utilisateur.
Chaque utilisateur peut gérer ses propres préférences.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import logging

from app.db import get_db
from app.hub_auth import get_current_user, TokenPayload
from app.models import UserPreference
from app.schemas import UserPreferenceUpdate, UserPreferenceResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["Preferences"])


@router.get("/preferences", response_model=UserPreferenceResponse)
async def get_preferences(
    user: TokenPayload = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Récupère les préférences de l'utilisateur connecté."""
    result = await db.execute(
        select(UserPreference).where(UserPreference.username == user.sub)
    )
    prefs = result.scalar_one_or_none()

    if not prefs:
        prefs = UserPreference(username=user.sub)
        db.add(prefs)
        await db.flush()
        await db.refresh(prefs)

    return UserPreferenceResponse.model_validate(prefs)


@router.put("/preferences", response_model=UserPreferenceResponse)
async def update_preferences(
    prefs_data: UserPreferenceUpdate,
    user: TokenPayload = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Met à jour les préférences de l'utilisateur connecté."""
    result = await db.execute(
        select(UserPreference).where(UserPreference.username == user.sub)
    )
    prefs = result.scalar_one_or_none()

    if not prefs:
        prefs = UserPreference(username=user.sub)
        db.add(prefs)

    update_data = prefs_data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(prefs, field, value)

    await db.flush()
    await db.refresh(prefs)

    return UserPreferenceResponse.model_validate(prefs)
