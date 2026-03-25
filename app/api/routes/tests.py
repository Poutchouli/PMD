"""
Routes pour tester les services de PMD par rapport au Hub.
"""
import asyncio
import httpx
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
import logging

from app.config import get_settings, APP_VERSION
from app.hub_auth import require_role, get_current_user, TokenPayload
from app.hub_client import hub_client

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api/tests", tags=["Tests Services"])


class ServiceTestResult(BaseModel):
    name: str
    success: bool
    duration_ms: float
    message: str
    details: Optional[dict] = None


class AllServicesTestResult(BaseModel):
    timestamp: str
    app_slug: str
    app_version: str
    overall_success: bool
    total_duration_ms: float
    tests: list[ServiceTestResult]
    summary: dict


async def _test_hub_connection() -> ServiceTestResult:
    start = datetime.now(timezone.utc)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{settings.hub_api_url}/api/health")
            hub_accessible = response.status_code == 200
        is_registered = hub_client.is_registered
        credentials_valid = False
        if is_registered:
            credentials_valid = await hub_client.ensure_valid_credentials()
        duration = (datetime.now(timezone.utc) - start).total_seconds() * 1000
        success = hub_accessible and is_registered and credentials_valid
        return ServiceTestResult(
            name="Hub Connection",
            success=success,
            duration_ms=duration,
            message="Connexion au Hub opérationnelle" if success else "Problème de connexion au Hub",
            details={
                "hub_url": settings.hub_api_url,
                "hub_accessible": hub_accessible,
                "app_registered": is_registered,
                "credentials_valid": credentials_valid,
            },
        )
    except Exception as e:
        duration = (datetime.now(timezone.utc) - start).total_seconds() * 1000
        return ServiceTestResult(
            name="Hub Connection",
            success=False,
            duration_ms=duration,
            message=f"Erreur de connexion: {e}",
            details={"error": str(e)},
        )


async def _test_slug_recovery(user: TokenPayload) -> ServiceTestResult:
    start = datetime.now(timezone.utc)
    try:
        app_role = user.get_app_role(settings.APP_SLUG)
        role_level = user.get_app_role_level(settings.APP_SLUG)
        is_service = user.is_service_account()
        has_user_info = bool(user.sub)
        has_role_info = app_role is not None or is_service
        duration = (datetime.now(timezone.utc) - start).total_seconds() * 1000
        success = has_user_info and has_role_info
        return ServiceTestResult(
            name="X-Slug Recovery",
            success=success,
            duration_ms=duration,
            message="Récupération X-Slug fonctionnelle" if success else "Problème récupération X-Slug",
            details={
                "username": user.sub,
                "app_slug": settings.APP_SLUG,
                "app_role": app_role,
                "role_level": role_level,
                "token_type": user.token_type,
                "is_service_account": is_service,
            },
        )
    except Exception as e:
        duration = (datetime.now(timezone.utc) - start).total_seconds() * 1000
        return ServiceTestResult(
            name="X-Slug Recovery",
            success=False,
            duration_ms=duration,
            message=f"Erreur: {e}",
            details={"error": str(e)},
        )


async def _test_m2m_service() -> ServiceTestResult:
    start = datetime.now(timezone.utc)
    try:
        token = await hub_client.get_m2m_token()
        has_token = token is not None
        services = []
        discovery_success = False
        if has_token:
            try:
                services = await hub_client.list_discovered_services(force_refresh=True)
                discovery_success = True
            except Exception as e:
                logger.warning("Échec découverte services: %s", e)
        duration = (datetime.now(timezone.utc) - start).total_seconds() * 1000
        success = has_token and discovery_success
        return ServiceTestResult(
            name="M2M Service",
            success=success,
            duration_ms=duration,
            message="Service M2M opérationnel" if success else "Problème avec le service M2M",
            details={
                "has_m2m_token": has_token,
                "discovery_success": discovery_success,
                "discovered_services_count": len(services),
            },
        )
    except Exception as e:
        duration = (datetime.now(timezone.utc) - start).total_seconds() * 1000
        return ServiceTestResult(
            name="M2M Service",
            success=False,
            duration_ms=duration,
            message=f"Erreur: {e}",
            details={"error": str(e)},
        )


async def _test_sse_connection() -> ServiceTestResult:
    start = datetime.now(timezone.utc)
    try:
        sse_url = f"{settings.hub_api_url}/api/events/stream"
        sse_accessible = False
        async with httpx.AsyncClient(timeout=5.0) as client:
            try:
                async with client.stream("GET", sse_url, timeout=2.0) as response:
                    sse_accessible = response.status_code == 200
            except httpx.ReadTimeout:
                sse_accessible = True  # Normal pour SSE
            except Exception:
                sse_accessible = False
        duration = (datetime.now(timezone.utc) - start).total_seconds() * 1000
        return ServiceTestResult(
            name="SSE Connection",
            success=sse_accessible,
            duration_ms=duration,
            message="Flux SSE accessible" if sse_accessible else "Flux SSE inaccessible",
            details={"sse_url": sse_url, "accessible": sse_accessible},
        )
    except Exception as e:
        duration = (datetime.now(timezone.utc) - start).total_seconds() * 1000
        return ServiceTestResult(
            name="SSE Connection",
            success=False,
            duration_ms=duration,
            message=f"Erreur: {e}",
            details={"error": str(e)},
        )


# ============================================================
# ENDPOINTS
# ============================================================

@router.get("/services", response_model=AllServicesTestResult)
async def test_all_services(user: TokenPayload = Depends(require_role("admin"))):
    """Teste tous les services (connexion, X-Slug, M2M, SSE)."""
    start = datetime.now(timezone.utc)
    results = await asyncio.gather(
        _test_hub_connection(),
        _test_slug_recovery(user),
        _test_m2m_service(),
        _test_sse_connection(),
    )
    total_duration = (datetime.now(timezone.utc) - start).total_seconds() * 1000
    test_list = list(results)
    passed = sum(1 for t in test_list if t.success)
    return AllServicesTestResult(
        timestamp=start.isoformat(),
        app_slug=settings.APP_SLUG,
        app_version=APP_VERSION,
        overall_success=all(t.success for t in test_list),
        total_duration_ms=total_duration,
        tests=test_list,
        summary={"total": len(test_list), "passed": passed, "failed": len(test_list) - passed},
    )


@router.get("/hub-connection", response_model=ServiceTestResult)
async def test_hub_connection(user: TokenPayload = Depends(get_current_user)):
    return await _test_hub_connection()


@router.get("/slug-recovery", response_model=ServiceTestResult)
async def test_slug_recovery(user: TokenPayload = Depends(get_current_user)):
    return await _test_slug_recovery(user)


@router.get("/m2m", response_model=ServiceTestResult)
async def test_m2m(user: TokenPayload = Depends(require_role("admin"))):
    return await _test_m2m_service()


@router.get("/sse", response_model=ServiceTestResult)
async def test_sse(user: TokenPayload = Depends(get_current_user)):
    return await _test_sse_connection()
