"""
Module d'authentification Hub avec validation JWT et gestion des rôles.

Fonctionnalités :
- Rotation automatique des clés JWKS (plus besoin de redéployer)
- Cache intelligent avec TTL de 30 minutes
- Fallback automatique sur clé PEM si JWKS indisponible
- Persistance du cache JWKS sur disque pour résilience
- Fallback en cascade : JWKS → cache mémoire → cache disque
"""
import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import IntEnum
from pathlib import Path
from typing import Any, Optional

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient

from app.config import get_settings

logger = logging.getLogger(__name__)

# Configuration du cache JWKS
JWKS_CACHE_TTL_SECONDS = 1800  # 30 minutes
PEM_CACHE_TTL_SECONDS = 3600  # 1 heure
PERSISTENT_CACHE_MAX_AGE_DAYS = 7

# Chemin du cache persistant
JWKS_PERSISTENT_CACHE_PATH = Path("storage/hub_jwks_cache.json")


class RoleLevel(IntEnum):
    """Niveaux de rôles hiérarchiques."""
    VIEWER = 1
    USER = 2
    MANAGER = 3
    ADMIN = 4
    SERVICE = 3


ROLE_MAPPING = {
    "viewer": RoleLevel.VIEWER,
    "user": RoleLevel.USER,
    "manager": RoleLevel.MANAGER,
    "admin": RoleLevel.ADMIN,
    "service": RoleLevel.SERVICE,
}


@dataclass
class TokenPayload:
    """Payload décodé du token JWT."""
    sub: str
    apps: dict[str, str]
    token_type: str
    exp: int
    iat: int
    jti: str

    def get_app_role(self, app_slug: str) -> Optional[str]:
        return self.apps.get(app_slug)

    def get_app_role_level(self, app_slug: str) -> int:
        role = self.get_app_role(app_slug)
        if role:
            return ROLE_MAPPING.get(role, 0)
        return 0

    def is_service_account(self) -> bool:
        return (
            self.token_type in ("service", "service_account")
            or "service" in self.apps.values()
        )


class HubAuth:
    """
    Gestion de l'authentification via le Hub.

    Stratégie de validation JWT :
    1. JWKS (standard OIDC) - Méthode recommandée avec rotation automatique
    2. Clé PEM statique - Fallback si JWKS indisponible
    """

    RECONNECT_COOLDOWN_SECONDS = 10
    MAX_RECONNECT_ATTEMPTS = 5
    RECONNECT_BACKOFF_SECONDS = 60

    def __init__(self):
        self.settings = get_settings()
        self._jwk_client: Optional[PyJWKClient] = None
        self._public_key: Optional[str] = None
        self._public_key_fetched_at: Optional[datetime] = None
        self._jwks_available: bool = True

        self._cached_jwks_keys: Optional[Any] = None
        self._cached_key_fetched_at: Optional[datetime] = None
        self._hub_reachable: bool = True

        self._reconnect_in_progress: bool = False
        self._last_reconnect_attempt: Optional[datetime] = None
        self._reconnect_attempt_count: int = 0
        self._reconnect_blocked_until: Optional[datetime] = None

    def _is_cache_expired(self) -> bool:
        if not self._cached_key_fetched_at:
            return True
        elapsed = (datetime.now(timezone.utc) - self._cached_key_fetched_at).total_seconds()
        return elapsed >= JWKS_CACHE_TTL_SECONDS

    def _save_key_to_persistent_cache(self, keys_data: dict) -> bool:
        try:
            JWKS_PERSISTENT_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            cache_data = {
                "keys": keys_data,
                "cached_at": datetime.now().isoformat(),
                "hub_url": self.settings.hub_api_url,
            }
            with open(JWKS_PERSISTENT_CACHE_PATH, "w") as f:
                json.dump(cache_data, f, indent=2)
            logger.info("✅ Cache JWKS persistant sauvegardé: %s", JWKS_PERSISTENT_CACHE_PATH)
            return True
        except Exception as e:
            logger.warning("⚠️ Impossible de sauvegarder le cache JWKS persistant: %s", e)
            return False

    def _load_key_from_persistent_cache(self) -> Optional[dict]:
        try:
            if not JWKS_PERSISTENT_CACHE_PATH.exists():
                return None
            with open(JWKS_PERSISTENT_CACHE_PATH, "r") as f:
                cache_data = json.load(f)
            cached_at = datetime.fromisoformat(cache_data.get("cached_at", ""))
            age_days = (datetime.now() - cached_at).days
            if age_days > PERSISTENT_CACHE_MAX_AGE_DAYS:
                logger.warning("⚠️ Cache JWKS persistant trop ancien (%d jours)", age_days)
                return None
            if cache_data.get("hub_url") != self.settings.hub_api_url:
                logger.warning("⚠️ Cache JWKS persistant provient d'un Hub différent")
                return None
            logger.info("✅ Cache JWKS persistant chargé (âge: %d jour(s))", age_days)
            return cache_data.get("keys")
        except Exception as e:
            logger.warning("⚠️ Erreur lecture cache JWKS persistant: %s", e)
            return None

    def get_jwks_cache_status(self) -> dict:
        memory_cache_age = None
        if self._cached_key_fetched_at:
            memory_cache_age = (datetime.now() - self._cached_key_fetched_at).total_seconds()

        persistent_cache_info: dict
        if JWKS_PERSISTENT_CACHE_PATH.exists():
            try:
                with open(JWKS_PERSISTENT_CACHE_PATH, "r") as f:
                    cache_data = json.load(f)
                cached_at = datetime.fromisoformat(cache_data.get("cached_at", ""))
                persistent_cache_info = {
                    "exists": True,
                    "cached_at": cached_at.isoformat(),
                    "age_seconds": (datetime.now() - cached_at).total_seconds(),
                    "age_days": (datetime.now() - cached_at).days,
                    "hub_url": cache_data.get("hub_url"),
                }
            except Exception:
                persistent_cache_info = {"exists": True, "error": "Impossible de lire le cache"}
        else:
            persistent_cache_info = {"exists": False}

        return {
            "jwks_available": self._jwks_available,
            "hub_reachable": self._hub_reachable,
            "memory_cache": {
                "has_keys": self._cached_jwks_keys is not None,
                "fetched_at": self._cached_key_fetched_at.isoformat() if self._cached_key_fetched_at else None,
                "age_seconds": memory_cache_age,
                "expired": self._is_cache_expired(),
                "ttl_seconds": JWKS_CACHE_TTL_SECONDS,
            },
            "persistent_cache": persistent_cache_info,
            "pem_fallback": {
                "available": self._public_key is not None,
                "fetched_at": self._public_key_fetched_at.isoformat() if self._public_key_fetched_at else None,
            },
        }

    async def initialize(self):
        """Initialise l'authentification en récupérant les clés du Hub."""
        # Tentative 1: JWKS
        try:
            jwks_url = f"{self.settings.hub_api_url}/api/auth/.well-known/jwks.json"
            self._jwk_client = PyJWKClient(
                jwks_url,
                cache_keys=True,
                lifespan=JWKS_CACHE_TTL_SECONDS,
            )
            signing_keys = self._jwk_client.get_signing_keys()
            self._jwks_available = True
            self._hub_reachable = True
            self._cached_key_fetched_at = datetime.now()

            if signing_keys:
                keys_data = [{"kid": k.key_id} for k in signing_keys]
                self._save_key_to_persistent_cache({"keys": keys_data, "count": len(signing_keys)})

            logger.info("✅ Authentification Hub initialisée (JWKS, cache %ds)", JWKS_CACHE_TTL_SECONDS)
            return
        except Exception as e:
            logger.warning("⚠️ JWKS indisponible depuis le Hub: %s", e)
            self._jwk_client = None
            self._jwks_available = False
            self._hub_reachable = False

        # Tentative 2: Cache persistant
        persistent_keys = self._load_key_from_persistent_cache()
        if persistent_keys:
            logger.info("✅ Authentification Hub initialisée (cache persistant)")
            self._cached_jwks_keys = persistent_keys

        # Tentative 3: Clé PEM
        await self._refresh_pem_key()
        if self._public_key:
            logger.info("✅ Authentification Hub initialisée (clé PEM)")
        elif persistent_keys:
            logger.warning("⚠️ Authentification Hub en mode dégradé (cache persistant uniquement)")
        else:
            logger.error("❌ Impossible d'initialiser l'authentification Hub")

    async def refresh_jwks_cache(self) -> dict:
        """Force le rafraîchissement du cache JWKS."""
        old_status = {
            "jwks_available": self._jwks_available,
            "hub_reachable": self._hub_reachable,
        }
        try:
            jwks_url = f"{self.settings.hub_api_url}/api/auth/.well-known/jwks.json"
            self._jwk_client = PyJWKClient(
                jwks_url,
                cache_keys=True,
                lifespan=JWKS_CACHE_TTL_SECONDS,
            )
            signing_keys = self._jwk_client.get_signing_keys()
            self._jwks_available = True
            self._hub_reachable = True
            self._cached_key_fetched_at = datetime.now()

            if signing_keys:
                keys_data = [{"kid": k.key_id} for k in signing_keys]
                self._save_key_to_persistent_cache({"keys": keys_data, "count": len(signing_keys)})

            return {
                "success": True,
                "message": "Cache JWKS rafraîchi avec succès",
                "previous_status": old_status,
                "new_status": {
                    "jwks_available": self._jwks_available,
                    "hub_reachable": self._hub_reachable,
                    "cached_at": self._cached_key_fetched_at.isoformat(),
                },
            }
        except Exception as e:
            self._hub_reachable = False
            return {
                "success": False,
                "message": f"Impossible de rafraîchir le cache JWKS: {e!s}",
                "previous_status": old_status,
                "new_status": {
                    "jwks_available": self._jwks_available,
                    "hub_reachable": self._hub_reachable,
                },
            }

    async def _refresh_pem_key(self) -> bool:
        from app.hub_client import hub_client

        try:
            self._public_key = await hub_client.fetch_public_key()
            if self._public_key:
                self._public_key_fetched_at = datetime.now()
                logger.info("✅ Clé PEM récupérée (fallback)")
                return True
        except Exception as e:
            logger.error("❌ Erreur récupération clé PEM: %s", e)
        return False

    def _is_pem_cache_valid(self) -> bool:
        if not self._public_key or not self._public_key_fetched_at:
            return False
        elapsed = (datetime.now() - self._public_key_fetched_at).total_seconds()
        return elapsed < PEM_CACHE_TTL_SECONDS

    def _decode_with_jwks(self, token: str) -> dict:
        signing_key = self._jwk_client.get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            options={"verify_exp": True},
        )

    def _decode_with_pem(self, token: str) -> dict:
        if not self._public_key:
            raise ValueError("Clé PEM non disponible")
        return jwt.decode(
            token,
            self._public_key,
            algorithms=["RS256"],
            options={"verify_exp": True},
        )

    def decode_token(self, token: str) -> TokenPayload:
        """
        Décode et valide un token JWT.

        Stratégie de validation avec fallback en cascade :
        1. JWKS depuis le Hub (recommandé, cache 30 min)
        2. Cache mémoire JWKS
        3. Cache persistant disque
        4. Clé PEM
        5. Erreur 503 si rien disponible
        """
        payload = None

        try:
            if self._jwk_client and self._jwks_available:
                try:
                    payload = self._decode_with_jwks(token)
                    self._hub_reachable = True
                    self._cached_key_fetched_at = datetime.now()
                except Exception as jwks_error:
                    logger.warning("⚠️ Hub JWKS indisponible en runtime: %s", jwks_error)
                    self._hub_reachable = False
                    self.schedule_reconnect()
                    try:
                        payload = self._decode_with_jwks(token)
                        logger.info("✅ Décodage réussi avec cache JWKS client")
                    except Exception:
                        if self._public_key:
                            logger.info("⚠️ Fallback sur clé PEM en cache")
                            payload = self._decode_with_pem(token)
                        else:
                            self.schedule_reconnect()
                            raise HTTPException(
                                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                                detail="Service d'authentification temporairement indisponible",
                            )
            elif self._public_key:
                payload = self._decode_with_pem(token)
                if not self._jwks_available:
                    self.schedule_reconnect()
            else:
                self.schedule_reconnect()
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Service d'authentification non disponible",
                )

            return TokenPayload(
                sub=payload.get("sub", ""),
                apps=payload.get("apps", {}),
                token_type=payload.get("type", payload.get("token_type", "user")),
                exp=payload.get("exp", 0),
                iat=payload.get("iat", 0),
                jti=payload.get("jti", ""),
            )

        except jwt.ExpiredSignatureError:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token expiré",
                headers={"WWW-Authenticate": "Bearer"},
            )
        except jwt.InvalidTokenError as e:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Token invalide: {e!s}",
                headers={"WWW-Authenticate": "Bearer"},
            )
        except HTTPException:
            raise
        except Exception as e:
            logger.error("❌ Erreur inattendue lors du décodage du token: %s", e)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Erreur interne lors de la validation du token",
            )

    async def try_restore_jwks(self) -> bool:
        if self._jwks_available:
            return True
        try:
            await self.initialize()
            if self._jwks_available:
                logger.info("✅ JWKS restauré après indisponibilité")
                return True
        except Exception as e:
            logger.debug("JWKS toujours indisponible: %s", e)
        return False

    def _can_attempt_reconnect(self) -> bool:
        now = datetime.now()
        if self._reconnect_blocked_until and now < self._reconnect_blocked_until:
            return False
        if self._reconnect_blocked_until and now >= self._reconnect_blocked_until:
            self._reconnect_blocked_until = None
            self._reconnect_attempt_count = 0
        if self._last_reconnect_attempt:
            elapsed = (now - self._last_reconnect_attempt).total_seconds()
            if elapsed < self.RECONNECT_COOLDOWN_SECONDS:
                return False
        return True

    async def _trigger_background_reconnect(self) -> None:
        if self._reconnect_in_progress:
            return
        if not self._can_attempt_reconnect():
            return

        self._reconnect_in_progress = True
        self._last_reconnect_attempt = datetime.now()
        self._reconnect_attempt_count += 1

        logger.info(
            "🔄 Tentative de reconnexion au Hub (%d/%d)...",
            self._reconnect_attempt_count,
            self.MAX_RECONNECT_ATTEMPTS,
        )

        try:
            await self.initialize()
            if self._jwks_available and self._hub_reachable:
                logger.info("✅ Reconnexion au Hub réussie!")
                self._reconnect_attempt_count = 0
                self._reconnect_blocked_until = None
            else:
                logger.warning("⚠️ Reconnexion échouée (tentative %d)", self._reconnect_attempt_count)
                if self._reconnect_attempt_count >= self.MAX_RECONNECT_ATTEMPTS:
                    self._reconnect_blocked_until = datetime.now() + timedelta(
                        seconds=self.RECONNECT_BACKOFF_SECONDS
                    )
                    logger.warning("⏳ Trop de tentatives échouées, pause de %ds", self.RECONNECT_BACKOFF_SECONDS)
        except Exception as e:
            logger.error("❌ Erreur lors de la tentative de reconnexion: %s", e)
            if self._reconnect_attempt_count >= self.MAX_RECONNECT_ATTEMPTS:
                self._reconnect_blocked_until = datetime.now() + timedelta(
                    seconds=self.RECONNECT_BACKOFF_SECONDS
                )
        finally:
            self._reconnect_in_progress = False

    def schedule_reconnect(self) -> None:
        if self._hub_reachable:
            return
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.create_task(self._trigger_background_reconnect())
        except RuntimeError:
            pass


# Instance singleton
hub_auth = HubAuth()

# Security scheme pour Swagger
security_scheme = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security_scheme),
) -> TokenPayload:
    """Dépendance FastAPI pour obtenir l'utilisateur courant. Requiert un token valide."""
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token d'authentification requis",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return hub_auth.decode_token(credentials.credentials)


async def get_optional_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security_scheme),
) -> Optional[TokenPayload]:
    """Dépendance FastAPI pour obtenir l'utilisateur courant (optionnel)."""
    if not credentials:
        return None
    try:
        return hub_auth.decode_token(credentials.credentials)
    except HTTPException:
        return None


def require_role(min_role: str):
    """
    Dépendance pour exiger un rôle minimum.

    Usage:
        @app.get("/admin")
        async def admin_endpoint(user: TokenPayload = Depends(require_role("admin"))):
            ...
    """
    min_level = ROLE_MAPPING.get(min_role, 0)
    settings = get_settings()

    async def role_checker(
        user: TokenPayload = Depends(get_current_user),
    ) -> TokenPayload:
        user_level = user.get_app_role_level(settings.APP_SLUG)
        if user_level < min_level:
            role_name = user.get_app_role(settings.APP_SLUG) or "aucun"
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Rôle insuffisant. Requis: {min_role}, Actuel: {role_name}",
            )
        return user

    return role_checker


def require_any_role(*roles: str):
    """Dépendance pour exiger l'un des rôles spécifiés."""
    settings = get_settings()

    async def role_checker(
        user: TokenPayload = Depends(get_current_user),
    ) -> TokenPayload:
        user_role = user.get_app_role(settings.APP_SLUG)
        if user_role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Rôle requis: {' ou '.join(roles)}. Actuel: {user_role or 'aucun'}",
            )
        return user

    return role_checker


def require_service_account():
    """Dépendance pour exiger un service account (M2M)."""

    async def service_checker(
        user: TokenPayload = Depends(get_current_user),
    ) -> TokenPayload:
        if not user.is_service_account():
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Accès réservé aux service accounts",
            )
        return user

    return service_checker
