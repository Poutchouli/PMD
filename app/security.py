"""
DEPRECATED — Auth is now handled by app.hub_auth.
This module exists only for backward-compatible imports.
"""
from app.hub_auth import get_current_user as require_auth  # noqa: F401
from app.hub_auth import get_current_user, get_optional_user, require_role  # noqa: F401