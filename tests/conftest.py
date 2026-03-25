"""
Fixtures partagées pour les tests PMD avec authentification Hub (mock).
"""
import os

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./test_pmd.db")
os.environ.setdefault("CORS_ORIGINS", "http://test")

import pytest
from unittest.mock import AsyncMock, patch

from app.hub_auth import TokenPayload


def create_mock_token(
    username: str = "admin",
    app_role: str = "admin",
    token_type: str = "user",
) -> TokenPayload:
    return TokenPayload(
        sub=username,
        apps={"pmd": app_role} if app_role else {},
        token_type=token_type,
        exp=9999999999,
        iat=1000000000,
        jti="test-token-id",
    )


@pytest.fixture
def mock_hub_client():
    with patch("app.hub_client.hub_client") as mock:
        mock.register = AsyncMock(return_value=True)
        mock.fetch_jwks = AsyncMock(return_value={"keys": []})
        mock.fetch_public_key = AsyncMock(return_value="MOCK_PEM")
        mock.get_m2m_token = AsyncMock(return_value="mock_m2m_token")
        mock.discover_services = AsyncMock(return_value=[])
        yield mock


@pytest.fixture
def mock_hub_auth():
    with patch("app.hub_auth.hub_auth") as mock:
        mock.initialize = AsyncMock()
        mock.decode_token = lambda token: create_mock_token()
        yield mock


@pytest.fixture
def admin_token_payload():
    return create_mock_token(username="admin", app_role="admin")
