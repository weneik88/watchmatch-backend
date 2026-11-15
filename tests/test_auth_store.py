import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from auth import AuthError, GoogleVerifier, bearer, make_token, verify_token
from settings import sanitize_settings
from store import Store

SECRET = b"unit-test-secret"
CLIENT_ID = "123-abc.apps.googleusercontent.com"


# --- session tokens -----------------------------------------------------------

def test_token_roundtrip():
    assert verify_token(make_token("g_1", SECRET), SECRET) == "g_1"


def test_token_expired():
    tok = make_token("g_1", SECRET, ttl=10, now=1000)
    assert verify_token(tok, SECRET, now=1005) == "g_1"
    assert verify_token(tok, SECRET, now=1011) is None


def test_token_tampering_and_wrong_secret():
    tok = make_token("g_1", SECRET)
    body, sig = tok.split(".")
    other = make_token("g_2", SECRET).split(".")[0]
    assert verify_token(f"{other}.{sig}", SECRET) is None
    assert verify_token(tok, b"another-secret") is None
    assert verify_token(tok + "x", SECRET) is None


@pytest.mark.parametrize("junk", [None, "", 5, "abc", "a.b.c", "." , "x" * 2000, b"bytes"])
def test_token_junk(junk):
    assert verify_token(junk, SECRET) is None


def test_bearer_header():
    assert bearer("Bearer abc") == "abc"
    assert bearer("bearer abc") == "abc"
    assert bearer("Basic abc") is None
    assert bearer(None) is None
    assert bearer("Bearer") is None


# --- google ---------------------------------------------------------------------

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class FakeJwk:
    def __init__(self, key):
        self.key = key


class FakeJwkClient:
    def get_signing_key_from_jwt(self, token):
        return FakeJwk(KEY.public_key())


def google_token(**overrides):
    now = int(time.time())
    claims = {
        "iss": "https://accounts.google.com", "aud": CLIENT_ID, "sub": "1234567890",
        "email": "ann@example.com", "email_verified": True, "name": "Ann",
        "picture": "https://lh3.googleusercontent.com/a/pic", "iat": now, "exp": now + 3600,
    }
    claims.update(overrides)
    return jwt.encode({k: v for k, v in claims.items() if v is not None}, KEY, algorithm="RS256")


def verifier():
    return GoogleVerifier(CLIENT_ID, jwk_client=FakeJwkClient())


def test_google_ok():
    info = verifier().verify(google_token())
    assert info == {"sub": "1234567890", "email": "ann@example.com", "name": "Ann",
                    "picture": "https://lh3.googleusercontent.com/a/pic"}


def test_google_old_issuer_form_ok():
    assert verifier().verify(google_token(iss="accounts.google.com"))["sub"] == "1234567890"


@pytest.mark.parametrize("overrides", [
    {"aud": "someone-elses-client-id"},
    {"iss": "https://evil.example.com"},
    {"exp": int(time.time()) - 3600},
    {"email_verified": False},
    {"email_verified": None},
    {"sub": None},
])
def test_google_rejects(overrides):
    with pytest.raises(AuthError):
        verifier().verify(google_token(**overrides))


def test_google_rejects_wrong_signature():
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = int(time.time())
    forged = jwt.encode({"iss": "https://accounts.google.com", "aud": CLIENT_ID, "sub": "1",
                         "email": "a@b.c", "email_verified": True, "iat": now, "exp": now + 60},
                        other, algorithm="RS256")
    with pytest.raises(AuthError):
        verifier().verify(forged)


def test_google_rejects_alg_none_and_hs256():
    now = int(time.time())
    claims = {"iss": "https://accounts.google.com", "aud": CLIENT_ID, "sub": "1",
              "email": "a@b.c", "email_verified": True, "iat": now, "exp": now + 60}
    for token in (jwt.encode(claims, None, algorithm="none"),
                  jwt.encode(claims, "secret", algorithm="HS256")):
        with pytest.raises(AuthError):
            verifier().verify(token)


@pytest.mark.parametrize("junk", [None, "", "abc", 5, "a" * 5000])
def test_google_junk(junk):
    with pytest.raises(AuthError):
        verifier().verify(junk)


# --- settings -----------------------------------------------------------------------

def test_settings_keep_valid_drop_invalid():
    out = sanitize_settings({
        "theme": "sunset", "accent": "#FF00AA", "blur": 999, "glass": -5, "radius": 20.7,
        "motion": "calm", "bg": "stars", "confetti": False, "sound": "yes", "cinema": True,
        "nickname": "  Аня \n  Т ", "evil": "<script>", "__proto__": {"x": 1},
    })
    assert out == {"theme": "sunset", "accent": "#ff00aa", "blur": 60, "glass": 2, "radius": 20,
                   "motion": "calm", "bg": "stars", "confetti": False, "cinema": True,
                   "nickname": "Аня Т"}


@pytest.mark.parametrize("raw", [None, 5, "x", [], {"theme": "nope", "accent": "red", "blur": "5",
                                                        "motion": 1, "blur ": 1, "radius": float("nan")}])
def test_settings_junk(raw):
    assert sanitize_settings(raw) == {}


def test_settings_nickname_length():
    assert len(sanitize_settings({"nickname": "я" * 100})["nickname"]) == 24


# --- store ---------------------------------------------------------------------------

@pytest.fixture
def store(tmp_path):
    return Store(str(tmp_path / "t.db"))


def test_register_then_login_keeps_settings(store):
    u = store.upsert_google_user("42", "a@b.c", "Ann", "https://pic")
    assert u["id"] == "g_42" and u["settings"] == {}
    store.save_settings("g_42", {"theme": "ocean", "junk": 1})
    again = store.upsert_google_user("42", "new@b.c", "Ann B", "https://pic2")
    assert again["settings"] == {"theme": "ocean"}
    assert again["email"] == "new@b.c" and again["name"] == "Ann B"


def test_users_are_isolated(store):
    store.upsert_google_user("1", "a@b.c", "A", None)
    store.upsert_google_user("2", "b@b.c", "B", None)
    store.save_settings("g_1", {"theme": "mint"})
    assert store.get_user("g_2")["settings"] == {}


def test_unknown_user(store):
    assert store.get_user("g_nope") is None
    assert store.save_settings("g_nope", {"theme": "mint"}) is None


def test_delete_user(store):
    store.upsert_google_user("1", "a@b.c", "A", None)
    assert store.delete_user("g_1") is True
    assert store.get_user("g_1") is None
    assert store.delete_user("g_1") is False


def test_sql_injection_is_inert(store):
    store.upsert_google_user("1'; DROP TABLE users;--", "a@b.c", "x'); --", None)
    assert store.get_user("g_1'; DROP TABLE users;--")["name"] == "x'); --"


def test_persistence_across_reopen(tmp_path):
    path = str(tmp_path / "p.db")
    Store(path).upsert_google_user("1", "a@b.c", "A", None)
    assert Store(path).get_user("g_1")["email"] == "a@b.c"
