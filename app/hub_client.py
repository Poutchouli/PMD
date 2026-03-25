"""
Client Hub pour l'auto-enregistrement M2M et la communication inter-services.

Fonctionnalités :
- Auto-enregistrement au démarrage
- Régénération automatique du secret si invalide (401)
- Cache du token M2M avec renouvellement automatique
- Protection contre les enregistrements concurrents (file lock + asyncio.Lock)
- Découverte dynamique des services partagés (IS_SHARED)
"""
import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional

import httpx

try:
    import fcntl
    HAS_FCNTL = True
except ImportError:
    HAS_FCNTL = False

from app.config import get_settings

logger = logging.getLogger(__name__)

# Storage dir
_storage_dir = Path("/app/storage")
try:
    _storage_dir.mkdir(parents=True, exist_ok=True)
except PermissionError:
    _storage_dir = Path("/tmp")
    logger.warning("⚠️ /app/storage inaccessible, fallback vers %s", _storage_dir)

MAX_RESYNC_ATTEMPTS = 3
DISCOVERED_SERVICES_CACHE_TTL = 60
REGISTER_LOCK_FILE = str(_storage_dir / ".hub_register.lock")
CREDENTIALS_FILE = str(_storage_dir / ".hub_credentials")


@dataclass
class DiscoveredService:
    """Service découvert via le Hub."""
    slug: str
    name: str
    api_url: str
    description: Optional[str] = None
    ip: Optional[str] = None
    api_port: Optional[int] = None
    frontend_port: Optional[int] = None
    frontend_url: Optional[str] = None
    version: Optional[str] = None
    registered_at: Optional[str] = None
    last_seen: Optional[str] = None
    is_healthy: bool = True
    is_shared: bool = True
    status: Optional[str] = None


@dataclass
class HubCredentials:
    """Credentials M2M. Sauvegardés dans un fichier local (mode 0600)."""
    client_id: str
    client_secret: str
    access_token: Optional[str] = None
    token_expires_at: Optional[datetime] = None


class HubClient:
    """Client pour communiquer avec le Hub."""

    def __init__(self):
        self.settings = get_settings()
        self._credentials: Optional[HubCredentials] = None
        self._public_key: Optional[str] = None
        self._jwks: Optional[dict] = None
        self._resync_lock = asyncio.Lock()
        self._last_resync_attempt: Optional[datetime] = None
        self._resync_count: int = 0
        self._discovered_services: Dict[str, DiscoveredService] = {}
        self._discovered_services_fetched_at: Optional[datetime] = None

    @property
    def is_registered(self) -> bool:
        return self._credentials is not None

    @property
    def credentials(self) -> Optional[HubCredentials]:
        return self._credentials

    def _save_credentials_to_file(self) -> None:
        if self._credentials:
            try:
                fd = os.open(CREDENTIALS_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as f:
                    f.write(f"{self._credentials.client_id}\n{self._credentials.client_secret}")
                logger.debug("💾 Credentials sauvegardés dans %s", CREDENTIALS_FILE)
            except Exception as e:
                logger.warning("⚠️ Impossible de sauvegarder les credentials: %s", e)

    def _load_credentials_from_file(self) -> bool:
        try:
            if os.path.exists(CREDENTIALS_FILE):
                with open(CREDENTIALS_FILE, "r") as f:
                    lines = f.read().strip().split("\n")
                    if len(lines) >= 2:
                        self._credentials = HubCredentials(
                            client_id=lines[0],
                            client_secret=lines[1],
                        )
                        logger.info("📂 Credentials chargés depuis %s", CREDENTIALS_FILE)
                        return True
        except Exception as e:
            logger.debug("Pas de credentials en cache: %s", e)
        return False

    async def register(self) -> bool:
        """Auto-enregistrement auprès du Hub."""
        if self._load_credentials_from_file():
            return True

        lock_file = None
        try:
            if HAS_FCNTL:
                lock_file = open(REGISTER_LOCK_FILE, "w")
                try:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except (IOError, OSError):
                    logger.info("⏳ Enregistrement en cours par un autre worker, attente...")
                    await asyncio.sleep(2)
                    if self._load_credentials_from_file():
                        return True
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                    if self._load_credentials_from_file():
                        return True
                if self._load_credentials_from_file():
                    return True

            return await self._do_register()
        finally:
            if lock_file:
                try:
                    if HAS_FCNTL:
                        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                    lock_file.close()
                except Exception:
                    pass

    async def _do_register(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                payload = {
                    "slug": self.settings.APP_SLUG,
                    "name": self.settings.APP_NAME,
                    "description": self.settings.APP_DESCRIPTION,
                    "api_port": self.settings.API_PORT,
                    "frontend_port": self.settings.FRONTEND_PORT,
                    "is_shared": self.settings.IS_SHARED,
                    "custom_host": self.settings.app_host,
                }
                if self.settings.is_remote_app:
                    logger.info("🌐 Application DISTANTE : enregistrement avec custom_host=%s", self.settings.app_host)
                else:
                    logger.info("📍 Application LOCALE : enregistrement avec custom_host=%s", self.settings.app_host)

                response = await client.post(
                    f"{self.settings.hub_api_url}/api/apps/register",
                    json=payload,
                )

                if response.status_code == 200:
                    data = response.json()
                    creds = data.get("credentials", data)
                    is_new = data.get("is_new", True)

                    if not is_new and not creds.get("client_secret"):
                        logger.info("Application existante, régénération du secret...")
                        return await self._recover_credentials()

                    self._credentials = HubCredentials(
                        client_id=creds["client_id"],
                        client_secret=creds["client_secret"],
                    )
                    self._save_credentials_to_file()
                    logger.info(
                        "✅ Application '%s' %s au Hub",
                        self.settings.APP_SLUG,
                        "enregistrée" if is_new else "reconnectée",
                    )
                    return True
                elif response.status_code == 409:
                    logger.info("Application déjà enregistrée, récupération des credentials...")
                    return await self._recover_credentials()
                else:
                    logger.error("❌ Échec enregistrement Hub: %d - %s", response.status_code, response.text)
                    return False
        except httpx.RequestError as e:
            logger.error("❌ Impossible de contacter le Hub: %s", e)
            return False

    async def _recover_credentials(self) -> bool:
        async with self._resync_lock:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    response = await client.post(
                        f"{self.settings.hub_api_url}/api/apps/me/regenerate-secret",
                        headers={"X-Slug": self.settings.APP_SLUG},
                    )
                    if response.status_code == 200:
                        data = response.json()
                        self._credentials = HubCredentials(
                            client_id=data["client_id"],
                            client_secret=data["client_secret"],
                        )
                        self._last_resync_attempt = datetime.now(timezone.utc)
                        self._resync_count += 1
                        self._save_credentials_to_file()
                        logger.info(
                            "✅ Credentials régénérés pour '%s' (resync #%d)",
                            self.settings.APP_SLUG,
                            self._resync_count,
                        )
                        return True
                    else:
                        logger.error("❌ Impossible de récupérer les credentials: %d - %s", response.status_code, response.text)
                        return False
            except httpx.RequestError as e:
                logger.error("❌ Erreur récupération credentials: %s", e)
                return False

    async def _auto_resync(self) -> bool:
        if self._last_resync_attempt:
            elapsed = (datetime.now(timezone.utc) - self._last_resync_attempt).total_seconds()
            if elapsed < 30:
                logger.warning("⚠️ Resync ignoré (dernier il y a %.0fs, cooldown 30s)", elapsed)
                return False
        logger.warning("🔄 Secret invalide détecté, resynchronisation automatique...")
        if self._credentials:
            self._credentials.access_token = None
            self._credentials.token_expires_at = None
        return await self._recover_credentials()

    async def get_m2m_token(self, _retry_count: int = 0) -> Optional[str]:
        """Obtient un token M2M pour les appels inter-services."""
        if not self._credentials:
            logger.warning("⚠️ Application non enregistrée, tentative d'enregistrement...")
            if await self.register():
                return await self.get_m2m_token(_retry_count=_retry_count)
            logger.error("❌ Impossible d'enregistrer l'application")
            return None

        if (
            self._credentials.access_token
            and self._credentials.token_expires_at
            and datetime.now(timezone.utc) < self._credentials.token_expires_at - timedelta(minutes=2)
        ):
            return self._credentials.access_token

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    f"{self.settings.hub_api_url}/api/auth/token",
                    data={
                        "grant_type": "client_credentials",
                        "client_id": self._credentials.client_id,
                        "client_secret": self._credentials.client_secret,
                    },
                )
                if response.status_code == 200:
                    data = response.json()
                    self._credentials.access_token = data["access_token"]
                    if "expires_at" in data:
                        try:
                            expires_str = data["expires_at"].replace("Z", "+00:00")
                            parsed = datetime.fromisoformat(expires_str)
                            if parsed.tzinfo is None:
                                parsed = parsed.replace(tzinfo=timezone.utc)
                            self._credentials.token_expires_at = parsed
                        except (ValueError, TypeError):
                            self._credentials.token_expires_at = datetime.now(timezone.utc) + timedelta(minutes=28)
                    else:
                        self._credentials.token_expires_at = datetime.now(timezone.utc) + timedelta(minutes=28)
                    logger.info("✅ Token M2M obtenu (expire: %s)", self._credentials.token_expires_at)
                    return self._credentials.access_token

                elif response.status_code == 401:
                    if _retry_count < MAX_RESYNC_ATTEMPTS:
                        logger.warning("⚠️ Erreur 401 - Secret invalide (tentative %d/%d)", _retry_count + 1, MAX_RESYNC_ATTEMPTS)
                        if await self._auto_resync():
                            return await self.get_m2m_token(_retry_count=_retry_count + 1)
                    else:
                        logger.error("❌ Max tentatives atteint (%d), abandon", MAX_RESYNC_ATTEMPTS)
                    return None
                else:
                    logger.error("❌ Échec obtention token M2M: %d - %s", response.status_code, response.text)
                    return None
        except httpx.RequestError as e:
            logger.error("❌ Erreur obtention token M2M: %s", e)
            return None

    async def ensure_valid_credentials(self) -> bool:
        token = await self.get_m2m_token()
        return token is not None

    async def fetch_jwks(self) -> Optional[dict]:
        if self._jwks:
            return self._jwks
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{self.settings.hub_api_url}/api/auth/.well-known/jwks.json")
                if response.status_code == 200:
                    self._jwks = response.json()
                    logger.info("✅ Clé JWKS récupérée du Hub")
                    return self._jwks
                else:
                    logger.error("❌ Échec récupération JWKS: %s", response.text)
                    return None
        except httpx.RequestError as e:
            logger.error("❌ Erreur récupération JWKS: %s", e)
            return None

    async def fetch_public_key(self) -> Optional[str]:
        if self._public_key:
            return self._public_key
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{self.settings.hub_api_url}/api/auth/public-key")
                if response.status_code == 200:
                    data = response.json()
                    self._public_key = data.get("public_key")
                    logger.info("✅ Clé publique PEM récupérée du Hub")
                    return self._public_key
                else:
                    logger.error("❌ Échec récupération clé publique: %s", response.text)
                    return None
        except httpx.RequestError as e:
            logger.error("❌ Erreur récupération clé publique: %s", e)
            return None

    async def discover_services(self, force_refresh: bool = False) -> Dict[str, DiscoveredService]:
        """Découvre les services partagés disponibles via le Hub."""
        if not force_refresh and self._discovered_services_fetched_at:
            elapsed = (datetime.now(timezone.utc) - self._discovered_services_fetched_at).total_seconds()
            if elapsed < DISCOVERED_SERVICES_CACHE_TTL:
                return self._discovered_services

        token = await self.get_m2m_token()
        if not token:
            logger.error("❌ Impossible d'obtenir un token M2M pour la découverte des services")
            return self._discovered_services

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{self.settings.hub_api_url}/api/apps/discover",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "X-Slug": self.settings.APP_SLUG,
                    },
                )
                if response.status_code == 200:
                    data = response.json()
                    services = (
                        data
                        if isinstance(data, list)
                        else data.get("shared_services", data.get("services", data.get("apps", [])))
                    )
                    self._discovered_services = {}
                    for svc in services:
                        slug = svc.get("slug")
                        if slug:
                            self._discovered_services[slug] = DiscoveredService(
                                slug=slug,
                                name=svc.get("name", slug),
                                api_url=svc.get("api_url", ""),
                                description=svc.get("description"),
                                ip=svc.get("ip"),
                                api_port=svc.get("api_port"),
                                frontend_port=svc.get("frontend_port"),
                                frontend_url=svc.get("frontend_url"),
                                version=svc.get("version"),
                                registered_at=svc.get("registered_at"),
                                last_seen=svc.get("last_seen"),
                                is_healthy=svc.get("is_healthy", True),
                                is_shared=svc.get("is_shared", True),
                                status=svc.get("status", "online" if svc.get("is_healthy", True) else "offline"),
                            )
                    self._discovered_services_fetched_at = datetime.now(timezone.utc)
                    logger.info("✅ %d service(s) partagé(s) découvert(s)", len(self._discovered_services))
                    return self._discovered_services
                else:
                    logger.error("❌ Échec découverte services: %d - %s", response.status_code, response.text)
                    return self._discovered_services
        except httpx.RequestError as e:
            logger.error("❌ Erreur découverte services: %s", e)
            return self._discovered_services

    async def get_service_by_slug(self, slug: str, force_refresh: bool = False) -> Optional[DiscoveredService]:
        services = await self.discover_services(force_refresh=force_refresh)
        return services.get(slug)

    async def call_discovered_service(
        self,
        service_slug: str,
        endpoint: str,
        method: str = "GET",
        _retry_on_401: bool = True,
        _retry_on_discover: bool = True,
        **kwargs,
    ) -> Optional[dict]:
        """Appelle un service découvert dynamiquement via M2M."""
        service = await self.get_service_by_slug(service_slug)
        if not service:
            if _retry_on_discover:
                service = await self.get_service_by_slug(service_slug, force_refresh=True)
            if not service:
                logger.error("❌ Service '%s' non trouvé", service_slug)
                return None

        if not service.api_url:
            logger.error("❌ Pas d'api_url pour le service '%s'", service_slug)
            return None

        token = await self.get_m2m_token()
        if not token:
            logger.error("❌ Impossible d'obtenir un token M2M pour appeler %s", service_slug)
            return None

        url = f"{service.api_url.rstrip('/')}{endpoint}"
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                headers = kwargs.pop("headers", {})
                headers["Authorization"] = f"Bearer {token}"
                headers["X-Slug"] = service_slug
                response = await client.request(method, url, headers=headers, **kwargs)

                if response.status_code == 200:
                    return response.json()
                elif response.status_code == 401 and _retry_on_401:
                    if await self._auto_resync():
                        return await self.call_discovered_service(
                            service_slug, endpoint, method,
                            _retry_on_401=False, _retry_on_discover=False,
                            **kwargs,
                        )
                    return None
                elif response.status_code == 404 and _retry_on_discover:
                    return await self.call_discovered_service(
                        service_slug, endpoint, method,
                        _retry_on_401=_retry_on_401, _retry_on_discover=False,
                        **kwargs,
                    )
                else:
                    logger.error("❌ Erreur appel service %s: %d - %s", service_slug, response.status_code, response.text[:200])
                    return None
        except httpx.RequestError as e:
            logger.error("❌ Erreur appel service %s: %s", service_slug, e)
            return None

    async def list_discovered_services(self, force_refresh: bool = False) -> List[DiscoveredService]:
        services = await self.discover_services(force_refresh=force_refresh)
        return list(services.values())

    async def call_hub_endpoint(
        self,
        endpoint: str,
        method: str = "GET",
        _retry_on_401: bool = True,
        timeout: float = 30.0,
        **kwargs,
    ) -> Optional[dict]:
        """Appelle directement un endpoint de l'API Hub avec authentification M2M."""
        token = await self.get_m2m_token()
        if not token:
            logger.error("❌ Impossible d'obtenir un token M2M pour appeler le Hub")
            return None

        url = f"{self.settings.hub_api_url.rstrip('/')}{endpoint}"
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                headers = kwargs.pop("headers", {})
                headers["Authorization"] = f"Bearer {token}"
                headers["X-Slug"] = self.settings.APP_SLUG
                response = await client.request(method, url, headers=headers, **kwargs)

                if response.status_code == 200:
                    try:
                        return response.json()
                    except Exception:
                        return {"success": True, "content": response.text[:500]}
                elif response.status_code == 401 and _retry_on_401:
                    if await self._auto_resync():
                        return await self.call_hub_endpoint(
                            endpoint, method, _retry_on_401=False, timeout=timeout, **kwargs,
                        )
                    return None
                else:
                    error_text = response.text[:200] if response.text else "(pas de contenu)"
                    logger.error("❌ Erreur appel Hub: %d - %s", response.status_code, error_text)
                    return {"error": error_text, "status_code": response.status_code}
        except httpx.RequestError as e:
            logger.error("❌ Erreur réseau appel Hub: %s", e)
            return None


# Instance singleton
hub_client = HubClient()
