from fastapi import APIRouter, Depends

from app.hub_auth import TokenPayload, get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/me")
async def get_me(user: TokenPayload = Depends(get_current_user)):
    """Retourne les informations de l'utilisateur connecté."""
    return {
        "username": user.sub,
        "apps": user.apps,
        "token_type": user.token_type,
        "is_service_account": user.is_service_account(),
    }
