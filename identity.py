"""Who is joining a room?

Sign-in is mandatory: the only way into a room is a valid session token that
belongs to an existing account. No token, a forged or expired token, or the
token of a deleted account all end in LoginRequired, and the websocket handler
closes the connection before any room is created or joined.

Kept free of FastAPI so it can be unit-tested.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Optional, Tuple

from auth import verify_token
from rooms import clean_name

GetUser = Callable[[str], Optional[Dict[str, Any]]]


class LoginRequired(Exception):
    pass


def resolve_identity(hello: Any, secret: bytes, get_user: GetUser) -> Tuple[str, Optional[str], str]:
    """Return (display name, avatar url or None, user id) or raise LoginRequired."""
    if not isinstance(hello, dict):
        raise LoginRequired()
    uid = verify_token(hello.get("token"), secret)
    user = get_user(uid) if uid else None
    if not user:
        raise LoginRequired()

    nickname = (user.get("settings") or {}).get("nickname")
    avatar = user.get("avatar")
    if not (isinstance(avatar, str) and avatar.startswith("https://")):
        avatar = None
    return clean_name(nickname or user.get("name"), "Гость"), avatar, user["id"]
