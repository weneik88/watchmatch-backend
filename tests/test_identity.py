"""Sign-in is mandatory: nothing but a valid session of an existing account gets in."""
import pytest

from auth import make_token
from identity import LoginRequired, resolve_identity
from store import Store

SECRET = b"unit-test-secret"


@pytest.fixture
def store(tmp_path):
    s = Store(str(tmp_path / "t.db"))
    s.upsert_google_user("42", "ann@example.com", "Ann Google", "https://lh3.googleusercontent.com/a/pic")
    return s


def hello(token=None, **extra):
    msg = {"t": "hello", **extra}
    if token is not None:
        msg["token"] = token
    return msg


def test_valid_session_gets_in(store):
    name, avatar, uid = resolve_identity(hello(make_token("g_42", SECRET)), SECRET, store.get_user)
    assert (name, avatar, uid) == ("Ann Google", "https://lh3.googleusercontent.com/a/pic", "g_42")


def test_nickname_beats_google_name(store):
    store.save_settings("g_42", {"nickname": "  Аня   Т "})
    name, _, _ = resolve_identity(hello(make_token("g_42", SECRET)), SECRET, store.get_user)
    assert name == "Аня Т"


def test_non_https_avatar_is_dropped(store):
    store.upsert_google_user("7", "b@example.com", "Bob", "http://insecure.example.com/x.png")
    _, avatar, _ = resolve_identity(hello(make_token("g_7", SECRET)), SECRET, store.get_user)
    assert avatar is None
    store.upsert_google_user("8", "c@example.com", "Cy", "javascript:alert(1)")
    assert resolve_identity(hello(make_token("g_8", SECRET)), SECRET, store.get_user)[1] is None


def test_no_token_is_refused_even_with_a_name(store):
    with pytest.raises(LoginRequired):
        resolve_identity(hello(name="Гость"), SECRET, store.get_user)
    with pytest.raises(LoginRequired):
        resolve_identity(hello(), SECRET, store.get_user)


@pytest.mark.parametrize("token", ["", "abc", "a.b", "a.b.c", 5, None, [], {}, "x" * 3000])
def test_junk_tokens_are_refused(store, token):
    with pytest.raises(LoginRequired):
        resolve_identity({"t": "hello", "token": token}, SECRET, store.get_user)


def test_forged_and_expired_tokens_are_refused(store):
    with pytest.raises(LoginRequired):
        resolve_identity(hello(make_token("g_42", b"another-secret")), SECRET, store.get_user)
    with pytest.raises(LoginRequired):
        resolve_identity(hello(make_token("g_42", SECRET, ttl=-10)), SECRET, store.get_user)


def test_token_of_a_deleted_or_unknown_account_is_refused(store):
    with pytest.raises(LoginRequired):
        resolve_identity(hello(make_token("g_999", SECRET)), SECRET, store.get_user)
    token = make_token("g_42", SECRET)
    store.delete_user("g_42")
    with pytest.raises(LoginRequired):
        resolve_identity(hello(token), SECRET, store.get_user)


@pytest.mark.parametrize("bad", [None, 5, "hello", [], ["token"]])
def test_non_object_hello_is_refused(store, bad):
    with pytest.raises(LoginRequired):
        resolve_identity(bad, SECRET, store.get_user)
