"""Session tokens and Google sign-in verification.

Flow: the browser gets a Google ID token from Google Identity Services and
posts it to /auth/google. We verify the signature locally against Google's
published keys (no call to the deprecated tokeninfo endpoint), check the
audience and issuer, then hand back our own short HMAC-signed session token.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any, Dict, Optional

import jwt  # PyJWT[crypto]

GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"]
DEFAULT_TTL = 30 * 24 * 3600


class AuthError(Exception):
    pass


# ----------------------------------------------------------------------------
# our own session tokens
# ----------------------------------------------------------------------------

def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(secret: bytes, body: str) -> str:
    return _b64e(hmac.new(secret, body.encode("ascii"), hashlib.sha256).digest())


def make_token(user_id: str, secret: bytes, ttl: int = DEFAULT_TTL, now: Optional[float] = None) -> str:
    now = time.time() if now is None else now
    payload = {"uid": user_id, "exp": int(now + ttl)}
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    return f"{body}.{_sign(secret, body)}"


def verify_token(token: Any, secret: bytes, now: Optional[float] = None) -> Optional[str]:
    """Return the user id for a valid, unexpired token, otherwise None."""
    if not isinstance(token, str) or token.count(".") != 1 or len(token) > 1024:
        return None
    body, sig = token.split(".")
    try:
        if not hmac.compare_digest(sig, _sign(secret, body)):
            return None
        payload = json.loads(_b64d(body))
    except Exception:
        return None
    now = time.time() if now is None else now
    if not isinstance(payload, dict) or not isinstance(payload.get("uid"), str):
        return None
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp < now:
        return None
    return payload["uid"]


def bearer(header: Optional[str]) -> Optional[str]:
    if not header:
        return None
    parts = header.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return None


# ----------------------------------------------------------------------------
# Google
# ----------------------------------------------------------------------------

class GoogleVerifier:
    def __init__(self, client_id: str, jwk_client: Any = None):
        self.client_id = client_id
        # PyJWKClient caches the key set, so most calls do not hit the network.
        self._jwk_client = jwk_client or jwt.PyJWKClient(GOOGLE_CERTS_URL, cache_keys=True)

    def verify(self, credential: Any) -> Dict[str, Any]:
        """Blocking. Run it in a thread from async code."""
        if not isinstance(credential, str) or not credential or len(credential) > 4096:
            raise AuthError("empty credential")
        try:
            key = self._jwk_client.get_signing_key_from_jwt(credential).key
            claims = jwt.decode(
                credential,
                key,
                algorithms=["RS256"],
                audience=self.client_id,
                issuer=GOOGLE_ISSUERS,
                leeway=10,
                options={"require": ["exp", "iat", "iss", "aud", "sub"]},
            )
        except Exception as exc:  # any failure means: not a valid Google token
            raise AuthError(f"invalid google token: {exc.__class__.__name__}") from exc

        if claims.get("email_verified") is not True:
            raise AuthError("email is not verified")

        email = claims.get("email")
        return {
            "sub": str(claims["sub"]),
            "email": email if isinstance(email, str) else "",
            "name": claims.get("name") or (email.split("@")[0] if isinstance(email, str) and email else "User"),
            "picture": claims.get("picture") if isinstance(claims.get("picture"), str) else None,
        }
