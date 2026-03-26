"""
Routes M2M (Machine-to-Machine) et découverte de services.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
import logging

from app.config import get_settings
from app.hub_auth import get_current_user, require_role, TokenPayload
from app.hub_client import hub_client
from app.schemas import ServiceDiscoveryResponse, DiscoveredServiceResponse

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api", tags=["M2M"])


@router.get("/m2m/status")
async def m2m_status(user: TokenPayload = Depends(require_role("admin"))):
    """Statut de la connexion M2M avec le Hub. Réservé aux admins."""
    is_registered = hub_client.is_registered
    token = None
    token_error = None

    if is_registered:
        try:
            token = await hub_client.get_m2m_token()
        except Exception as e:
            token_error = str(e)

    return {
        "registered": is_registered,
        "client_id": hub_client.credentials.client_id if hub_client.credentials else None,
        "can_get_token": token is not None,
        "token_preview": f"{token[:20]}...{token[-10:]}" if token else None,
        "error": token_error,
    }


@router.get("/apps/discover", response_model=ServiceDiscoveryResponse, tags=["Services"])
async def discover_services(
    force_refresh: bool = Query(False, description="Forcer le rafraîchissement du cache"),
    user: TokenPayload = Depends(get_current_user),
):
    """Découvre les services partagés disponibles via le Hub."""
    try:
        services = await hub_client.list_discovered_services(force_refresh=force_refresh)
        return ServiceDiscoveryResponse(
            count=len(services),
            services=[
                DiscoveredServiceResponse(
                    slug=svc.slug,
                    name=svc.name,
                    description=svc.description,
                    api_url=svc.api_url,
                    frontend_url=svc.frontend_url,
                    version=svc.version,
                    status=svc.status,
                    is_healthy=svc.is_healthy,
                )
                for svc in services
            ],
            cached_at=(
                hub_client._discovered_services_fetched_at.isoformat()
                if hub_client._discovered_services_fetched_at
                else None
            ),
        )
    except Exception as e:
        logger.error("Erreur découverte services: %s", e)
        raise HTTPException(status_code=503, detail=f"Impossible de découvrir les services: {e}")


@router.get("/m2m/discover")
async def discover_m2m_services(
    force_refresh: bool = Query(False, description="Forcer le rafraîchissement du cache"),
    user: TokenPayload = Depends(require_role("admin")),
):
    """Découvre les services partagés avec infos techniques (admin)."""
    try:
        services = await hub_client.list_discovered_services(force_refresh=force_refresh)
        return {
            "count": len(services),
            "services": [
                {
                    "slug": svc.slug,
                    "name": svc.name,
                    "description": svc.description,
                    "ip": svc.ip,
                    "api_url": svc.api_url,
                    "api_port": svc.api_port,
                    "frontend_url": svc.frontend_url,
                    "frontend_port": svc.frontend_port,
                    "version": svc.version,
                    "registered_at": svc.registered_at,
                    "last_seen": svc.last_seen,
                    "status": svc.status,
                    "is_healthy": svc.is_healthy,
                    "is_shared": svc.is_shared,
                }
                for svc in services
            ],
            "cached_at": (
                hub_client._discovered_services_fetched_at.isoformat()
                if hub_client._discovered_services_fetched_at
                else None
            ),
        }
    except Exception as e:
        logger.error("Erreur découverte services: %s", e)
        raise HTTPException(status_code=503, detail=f"Impossible de découvrir les services: {e}")


@router.post("/m2m/call/{service_slug}")
async def call_discovered_service(
    service_slug: str,
    endpoint: str = Query(..., description="Endpoint à appeler (ex: /api/targets)"),
    method: str = Query("GET", description="Méthode HTTP"),
    user: TokenPayload = Depends(require_role("admin")),
):
    """Appelle un service découvert via M2M."""
    service = await hub_client.get_service_by_slug(service_slug)
    if not service:
        raise HTTPException(status_code=404, detail=f"Service '{service_slug}' non trouvé")

    try:
        result = await hub_client.call_discovered_service(
            service_slug=service_slug,
            endpoint=endpoint,
            method=method.upper(),
        )
        if result is None:
            raise HTTPException(status_code=502, detail=f"Aucune réponse du service '{service_slug}'")
        return {
            "success": True,
            "service": {"slug": service.slug, "api_url": service.api_url},
            "endpoint": endpoint,
            "method": method.upper(),
            "response": result,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Erreur appel service %s: %s", service_slug, e)
        raise HTTPException(status_code=502, detail=f"Erreur appel service: {e}")
