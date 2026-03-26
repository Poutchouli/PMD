import logging
import asyncio
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from fastapi import FastAPI, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncEngine

from app.config import get_settings, APP_VERSION
from app.db import engine
from app.models import Base
from app.hub_client import hub_client
from app.hub_auth import (
    hub_auth,
    require_role,
    TokenPayload,
)

# Routeurs
from app.api.routes.auth import router as auth_router
from app.api.routes.targets import router as targets_router
from app.api.routes.groups import router as groups_router
from app.api.routes.preferences import router as preferences_router
from app.api.routes.m2m import router as m2m_router
from app.api.routes.backup import router as backup_router
from app.api.routes.tests import router as tests_router
from app.api.routes.docs import router as docs_router

from app.services.scheduler import scheduler

logger = logging.getLogger(__name__)


async def _init_db(async_engine: AsyncEngine):
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def hub_reconnection_loop():
    """Boucle de reconnexion automatique au Hub."""
    RECONNECT_INTERVAL = 15

    while True:
        try:
            await asyncio.sleep(RECONNECT_INTERVAL)

            if not hub_client.is_registered:
                logger.info("🔄 Hub non enregistré, tentative de reconnexion...")
                registered = await hub_client.register()
                if registered:
                    logger.info("✅ Enregistrement Hub réussi!")
                    await hub_auth.initialize()

            if not hub_auth._jwks_available or not hub_auth._hub_reachable:
                logger.info("🔄 JWKS/Hub indisponible, tentative de restauration...")
                await hub_auth.initialize()
                if hub_auth._jwks_available:
                    logger.info("✅ Connexion JWKS restaurée!")

        except asyncio.CancelledError:
            logger.info("🛑 Arrêt de la boucle de reconnexion Hub")
            break
        except Exception as e:
            logger.debug("Erreur dans la boucle de reconnexion: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    startup_time = datetime.now(timezone.utc)
    logger.info("🚀 Démarrage de '%s'...", settings.APP_SLUG)

    # 1. Auto-enregistrement auprès du Hub
    registered = await hub_client.register()
    if not registered:
        logger.warning("⚠️ Impossible de s'enregistrer auprès du Hub. Mode dégradé.")

    # 2. Initialisation de l'authentification Hub
    await hub_auth.initialize()

    # 3. Initialisation de la base de données
    await _init_db(engine)
    logger.info("✅ Base de données initialisée")

    # 4. Chargement des targets existantes dans le scheduler
    await scheduler.load_existing()

    # 5. Découverte des services partagés
    discovered_count = 0
    if registered:
        try:
            services = await hub_client.discover_services()
            discovered_count = len(services)
            if discovered_count > 0:
                logger.info("🔍 %d service(s) partagé(s) découvert(s)", discovered_count)
        except Exception as e:
            logger.warning("⚠️ Erreur découverte services: %s", e)

    # 6. Stocker les infos de démarrage
    app.state.startup_time = startup_time
    app.state.is_registered = registered
    app.state.discovered_services_count = discovered_count
    app.state.hub_reconnect_task = None

    # 7. Tâche de reconnexion en arrière-plan si nécessaire
    if not registered or not hub_auth._jwks_available:
        app.state.hub_reconnect_task = asyncio.create_task(hub_reconnection_loop())
        logger.info("🔄 Tâche de reconnexion Hub démarrée")

    startup_duration = (datetime.now(timezone.utc) - startup_time).total_seconds()
    logger.info("✅ Application prête sur %s (démarrage en %.2fs)", settings.api_url, startup_duration)

    yield

    # Arrêt
    logger.info("🛑 Arrêt de l'application...")
    reconnect_task = getattr(app.state, "hub_reconnect_task", None)
    if reconnect_task and not reconnect_task.done():
        reconnect_task.cancel()
        try:
            await reconnect_task
        except asyncio.CancelledError:
            pass
    await scheduler.shutdown()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.APP_NAME,
        description=settings.APP_DESCRIPTION,
        version=APP_VERSION,
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )

    # CORS
    cors_origins = (
        os.environ.get("CORS_ORIGINS", "").split(",")
        if os.environ.get("CORS_ORIGINS")
        else [
            f"http://localhost:{settings.FRONTEND_PORT}",
            f"http://{settings.app_host}:{settings.FRONTEND_PORT}",
        ]
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    # Routeurs métier
    app.include_router(auth_router)
    app.include_router(targets_router)
    app.include_router(groups_router)

    # Routeurs Hub
    app.include_router(preferences_router)
    app.include_router(m2m_router)
    app.include_router(backup_router)
    app.include_router(tests_router)
    app.include_router(docs_router)

    # Global exception handler for unhandled errors
    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.error("Unhandled error on %s %s: %s", request.method, request.url.path, exc)
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error"},
        )

    # ============================================================
    # ENDPOINTS PUBLICS (health, config, version, jwks)
    # ============================================================

    @app.get("/api/health", tags=["Public"])
    async def health_check():
        hub_registered = getattr(app.state, "is_registered", False)
        return {
            "status": "healthy",
            "app": settings.APP_SLUG,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "hub_connected": hub_registered,
        }

    @app.get("/api/health/detailed", tags=["Public"])
    async def health_check_detailed():
        now = datetime.now(timezone.utc)
        startup_time = getattr(app.state, "startup_time", None)
        uptime_seconds = (now - startup_time).total_seconds() if startup_time else None
        hub_registered = hub_client.is_registered
        hub_can_authenticate = False
        if hub_registered:
            try:
                token = await hub_client.get_m2m_token()
                hub_can_authenticate = token is not None
            except Exception:
                pass
        discovered_services = await hub_client.list_discovered_services()
        jwks_cache_status = hub_auth.get_jwks_cache_status()
        return {
            "status": "healthy" if hub_registered else "degraded",
            "app": {"slug": settings.APP_SLUG, "name": settings.APP_NAME, "version": APP_VERSION},
            "timestamp": now.isoformat(),
            "uptime_seconds": uptime_seconds,
            "hub": {
                "connected": hub_registered,
                "can_authenticate": hub_can_authenticate,
                "api_url": settings.hub_api_url,
            },
            "services": {
                "discovered_count": len(discovered_services),
                "services": [
                    {"slug": s.slug, "status": s.status, "is_healthy": s.is_healthy}
                    for s in discovered_services[:10]
                ],
            },
            "jwks_cache": jwks_cache_status,
            "config": {"is_shared": settings.IS_SHARED, "debug": settings.DEBUG},
        }

    @app.get("/api/health/hub/jwks", tags=["Public"])
    async def health_hub_jwks():
        return hub_auth.get_jwks_cache_status()

    @app.post("/api/health/hub/jwks/refresh", tags=["Admin"])
    async def health_hub_jwks_refresh(user: TokenPayload = Depends(require_role("admin"))):
        return await hub_auth.refresh_jwks_cache()

    @app.get("/api/version", tags=["Public"])
    async def get_version():
        return {"app": settings.APP_SLUG, "version": APP_VERSION, "name": settings.APP_NAME}

    @app.get("/api/config", tags=["Public"])
    async def get_config():
        return {
            "app_slug": settings.APP_SLUG,
            "app_name": settings.APP_NAME,
            "version": APP_VERSION,
            "hub_api_url": settings.hub_api_url,
            "hub_frontend_url": settings.hub_frontend_url,
            "api_url": settings.api_url,
            "frontend_url": settings.frontend_url,
            "is_shared": settings.IS_SHARED,
        }

    return app
