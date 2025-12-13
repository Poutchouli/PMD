import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncEngine

from app.config import get_settings
from app.db import engine
from app.models import Base
from app.api.routes.auth import router as auth_router
from app.api.routes.targets import router as targets_router
from app.services.scheduler import scheduler

logger = logging.getLogger(__name__)


async def _init_db(async_engine: AsyncEngine):
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await _init_db(engine)
    await scheduler.load_existing()
    yield
    await scheduler.shutdown()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version=settings.app_version, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(auth_router)
    app.include_router(targets_router)
    return app
