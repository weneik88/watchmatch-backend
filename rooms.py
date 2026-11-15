"""Room logic for WatchMatch.

Pure Python: no FastAPI, no network, no clock access. Every function that
needs time takes it as an argument, so the whole module is unit-testable.

Protocol (client -> server), all messages are JSON objects with a "t" field:

    ping    {c}                      -> pong {c, s}
    chat    {text}
    react   {emoji}
    party   {kind}                   confetti | popcorn | shake | disco
    rename  {name}
    load    {url}                    controller only
    play    {pos?}                   controller only
    pause   {pos?}                   controller only
    seek    {pos}                    controller only
    rate    {rate}                   controller only
    countdown {}                     controller only, synchronised 3-2-1 start
    control {open}                   host only, lets everybody control playback
    host    {to}                     host only, hand over the host role

Server -> client messages are built by Room.snapshot() and Room.handle().
"""
from __future__ import annotations

import math
import re
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

ROOM_ID_RE = re.compile(r"^[A-Za-z0-9_-]{3,32}$")
YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f‎‏‪-‮⁦-⁩]")

# Emoji reactions are compared without the variation selector so that
# "❤" and "❤️" are treated the same; the canonical form is what we broadcast.
_REACTIONS = ["❤️", "😂", "😮", "😢", "👏", "🔥", "🍿", "🤯", "😴", "👀"]
REACTIONS = {e.replace("️", ""): e for e in _REACTIONS}

PARTY_KINDS = {"confetti", "popcorn", "shake", "disco"}

MAX_CHAT_LEN = 300
MAX_NAME_LEN = 24
MAX_URL_LEN = 2000
COUNTDOWN_MS = 3000
MAX_POSITION = 24 * 3600 * 10  # ten days, just a sanity cap

YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com",
}


class RoomFull(Exception):
    pass


class TooManyRooms(Exception):
    pass


# ----------------------------------------------------------------------------
# sanitising helpers
# ----------------------------------------------------------------------------

def clean_text(value: Any, max_len: int) -> str:
    if not isinstance(value, str):
        return ""
    value = CONTROL_CHARS_RE.sub("", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value[:max_len]


def clean_name(value: Any, default: str) -> str:
    name = clean_text(value, MAX_NAME_LEN)
    return name or default


def parse_source(url: Any) -> Optional[Dict[str, str]]:
    """Turn a user supplied link into a source description, or None."""
    if not isinstance(url, str):
        return None
    url = url.strip()
    if not url or len(url) > MAX_URL_LEN or CONTROL_CHARS_RE.search(url):
        return None
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None

    host = (parsed.hostname or "").lower()
    if host in YOUTUBE_HOSTS:
        vid = _youtube_id(parsed, host)
        if not vid:
            return None
        return {"kind": "youtube", "id": vid, "url": f"https://www.youtube.com/watch?v={vid}"}

    return {"kind": "file", "url": url}


def _youtube_id(parsed, host: str) -> Optional[str]:
    parts = [p for p in parsed.path.split("/") if p]
    candidate: Optional[str] = None
    if host.endswith("youtu.be"):
        candidate = parts[0] if parts else None
    elif parts and parts[0] in ("embed", "shorts", "live", "v") and len(parts) > 1:
        candidate = parts[1]
    elif parts and parts[0] == "watch":
        candidate = (parse_qs(parsed.query).get("v") or [None])[0]
    return candidate if candidate and YT_ID_RE.match(candidate) else None


def _finite(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def _position(value: Any) -> Optional[float]:
    v = _finite(value)
    if v is None:
        return None
    return min(max(v, 0.0), float(MAX_POSITION))


# ----------------------------------------------------------------------------
# rate limiting
# ----------------------------------------------------------------------------

class Bucket:
    """Token bucket. `rate` tokens per second, up to `capacity`."""

    def __init__(self, capacity: float, rate: float):
        self.capacity = float(capacity)
        self.rate = float(rate)
        self.tokens = float(capacity)
        self.last: Optional[float] = None

    def take(self, now: float, n: float = 1.0) -> bool:
        if self.last is not None:
            self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.rate)
        self.last = now
        if self.tokens >= n:
            self.tokens -= n
            return True
        return False


def default_buckets() -> Dict[str, Bucket]:
    return {
        "any": Bucket(40, 20),
        "chat": Bucket(5, 1.5),
        "react": Bucket(10, 5),
        "party": Bucket(2, 0.2),
        "control": Bucket(15, 5),
    }


# ----------------------------------------------------------------------------
# data classes
# ----------------------------------------------------------------------------

@dataclass
class Member:
    id: str
    name: str
    avatar: Optional[str] = None
    user_id: Optional[str] = None
    joined_at: int = 0
    conn: Any = None  # the transport object, opaque to this module
    buckets: Dict[str, Bucket] = field(default_factory=default_buckets)

    def public(self, host_id: Optional[str]) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "avatar": self.avatar,
            "host": self.id == host_id,
            "guest": self.user_id is None,
        }


@dataclass
class Out:
    """An outgoing message. `to` is a member id or "all"."""
    to: str
    payload: Dict[str, Any]
    exclude: Optional[str] = None


def _error(member_id: str, code: str, message: str) -> Out:
    return Out(member_id, {"t": "error", "code": code, "message": message})


# ----------------------------------------------------------------------------
# room
# ----------------------------------------------------------------------------

class Room:
    def __init__(self, room_id: str, max_members: int = 12):
        self.id = room_id
        self.max_members = max_members
        self.members: Dict[str, Member] = {}
        self.host_id: Optional[str] = None
        self.open_control = False
        self.chat: Deque[Dict[str, Any]] = deque(maxlen=50)
        self.state: Dict[str, Any] = {
            "src": None, "playing": False, "pos": 0.0, "at": 0, "rate": 1.0,
        }

    # -- state ---------------------------------------------------------------

    def position(self, now_ms: int) -> float:
        s = self.state
        if s["playing"]:
            return s["pos"] + max(0, now_ms - s["at"]) / 1000.0 * s["rate"]
        return s["pos"]

    def can_control(self, member_id: str) -> bool:
        return member_id == self.host_id or self.open_control

    def members_message(self) -> Dict[str, Any]:
        ordered = sorted(self.members.values(), key=lambda m: m.joined_at)
        return {
            "t": "members",
            "members": [m.public(self.host_id) for m in ordered],
            "host": self.host_id,
            "open": self.open_control,
        }

    def snapshot(self, now_ms: int, member_id: str) -> Dict[str, Any]:
        msg = self.members_message()
        msg.update({
            "t": "welcome",
            "you": member_id,
            "room": self.id,
            "state": dict(self.state),
            "chat": list(self.chat),
            "now": now_ms,
            "maxMembers": self.max_members,
        })
        return msg

    # -- membership ------------------------------------------------------------

    def add_member(self, member: Member, now_ms: int) -> List[Out]:
        if len(self.members) >= self.max_members:
            raise RoomFull()
        member.joined_at = now_ms
        self.members[member.id] = member
        if self.host_id is None:
            self.host_id = member.id
        return [
            Out(member.id, self.snapshot(now_ms, member.id)),
            Out("all", {"t": "join", "member": member.public(self.host_id)}, exclude=member.id),
            Out("all", self.members_message(), exclude=member.id),
        ]

    def remove_member(self, member_id: str, now_ms: int) -> List[Out]:
        member = self.members.pop(member_id, None)
        if member is None:
            return []
        was_host = member_id == self.host_id
        if was_host:
            self.host_id = None
            if self.members:
                self.host_id = min(self.members.values(), key=lambda m: m.joined_at).id
        outs = [Out("all", {
            "t": "leave",
            "member": member.public(None),
            "newHost": self.host_id if was_host else None,
        })]
        if self.members:
            outs.append(Out("all", self.members_message()))
        return outs

    # -- message handling ----------------------------------------------------------

    def handle(self, member_id: str, msg: Any, now_ms: int) -> List[Out]:
        member = self.members.get(member_id)
        if member is None or not isinstance(msg, dict):
            return []
        kind = msg.get("t")
        if not isinstance(kind, str):
            return []

        now_s = now_ms / 1000.0
        if not member.buckets["any"].take(now_s):
            return []  # silently drop floods; the transport counts these

        handler = getattr(self, f"_on_{kind}", None)
        if handler is None:
            return []
        return handler(member, msg, now_ms)

    # simple messages

    def _on_ping(self, member: Member, msg, now_ms) -> List[Out]:
        c = _finite(msg.get("c"))
        if c is None:
            return []
        return [Out(member.id, {"t": "pong", "c": c, "s": now_ms})]

    def _on_chat(self, member: Member, msg, now_ms) -> List[Out]:
        text = clean_text(msg.get("text"), MAX_CHAT_LEN)
        if not text:
            return []
        if not member.buckets["chat"].take(now_ms / 1000.0):
            return [_error(member.id, "rate", "Слишком часто. Помедленнее :)")]
        entry = {
            "t": "chat",
            "id": secrets.token_hex(4),
            "from": member.id,
            "name": member.name,
            "avatar": member.avatar,
            "text": text,
            "ts": now_ms,
        }
        self.chat.append(entry)
        return [Out("all", entry)]

    def _on_react(self, member: Member, msg, now_ms) -> List[Out]:
        emoji = msg.get("emoji")
        if not isinstance(emoji, str):
            return []
        canonical = REACTIONS.get(emoji.replace("️", ""))
        if canonical is None:
            return []
        if not member.buckets["react"].take(now_ms / 1000.0):
            return []
        return [Out("all", {"t": "react", "emoji": canonical, "from": member.id, "name": member.name})]

    def _on_party(self, member: Member, msg, now_ms) -> List[Out]:
        kind = msg.get("kind")
        if kind not in PARTY_KINDS:
            return []
        if not member.buckets["party"].take(now_ms / 1000.0):
            return [_error(member.id, "rate", "Вечеринку можно устраивать не так часто")]
        return [Out("all", {"t": "party", "kind": kind, "from": member.id, "name": member.name})]

    def _on_rename(self, member: Member, msg, now_ms) -> List[Out]:
        name = clean_text(msg.get("name"), MAX_NAME_LEN)
        if not name or name == member.name:
            return []
        member.name = name
        return [Out("all", self.members_message())]

    # host-only messages

    def _on_control(self, member: Member, msg, now_ms) -> List[Out]:
        if member.id != self.host_id:
            return [_error(member.id, "forbidden", "Это может только хост")]
        if not isinstance(msg.get("open"), bool):
            return []
        self.open_control = msg["open"]
        return [Out("all", self.members_message())]

    def _on_host(self, member: Member, msg, now_ms) -> List[Out]:
        if member.id != self.host_id:
            return [_error(member.id, "forbidden", "Это может только хост")]
        target = msg.get("to")
        if not isinstance(target, str) or target not in self.members:
            return []
        self.host_id = target
        return [Out("all", {"t": "hostchanged", "host": target, "name": self.members[target].name}),
                Out("all", self.members_message())]

    # playback messages

    def _check_control(self, member: Member, now_ms: int) -> Optional[Out]:
        if not self.can_control(member.id):
            return _error(member.id, "forbidden", "Пульт сейчас у хоста")
        if not member.buckets["control"].take(now_ms / 1000.0):
            return _error(member.id, "rate", "Слишком много команд")
        return None

    def _state_out(self, member: Member, reason: str, now_ms: int) -> Out:
        return Out("all", {
            "t": "state", "reason": reason, "by": member.id, "name": member.name,
            "state": dict(self.state), "now": now_ms,
        })

    def _on_load(self, member: Member, msg, now_ms) -> List[Out]:
        denied = self._check_control(member, now_ms)
        if denied:
            return [denied]
        src = parse_source(msg.get("url"))
        if src is None:
            return [_error(member.id, "bad_url", "Не похоже на ссылку на видео")]
        self.state = {"src": src, "playing": False, "pos": 0.0, "at": now_ms, "rate": 1.0}
        return [self._state_out(member, "load", now_ms)]

    def _on_play(self, member: Member, msg, now_ms) -> List[Out]:
        denied = self._check_control(member, now_ms)
        if denied:
            return [denied]
        if self.state["src"] is None:
            return [_error(member.id, "no_video", "Сначала загрузите видео")]
        pos = _position(msg.get("pos"))
        if pos is None:
            pos = self.position(now_ms)
        self.state.update(playing=True, pos=pos, at=now_ms)
        return [self._state_out(member, "play", now_ms)]

    def _on_pause(self, member: Member, msg, now_ms) -> List[Out]:
        denied = self._check_control(member, now_ms)
        if denied:
            return [denied]
        if self.state["src"] is None:
            return []
        pos = _position(msg.get("pos"))
        if pos is None:
            pos = self.position(now_ms)
        self.state.update(playing=False, pos=pos, at=now_ms)
        return [self._state_out(member, "pause", now_ms)]

    def _on_seek(self, member: Member, msg, now_ms) -> List[Out]:
        denied = self._check_control(member, now_ms)
        if denied:
            return [denied]
        if self.state["src"] is None:
            return []
        pos = _position(msg.get("pos"))
        if pos is None:
            return []
        self.state.update(pos=pos, at=now_ms)
        return [self._state_out(member, "seek", now_ms)]

    def _on_rate(self, member: Member, msg, now_ms) -> List[Out]:
        denied = self._check_control(member, now_ms)
        if denied:
            return [denied]
        rate = _finite(msg.get("rate"))
        if rate is None or not 0.25 <= rate <= 2.0:
            return []
        # re-anchor first so the position does not jump when the speed changes
        self.state.update(pos=self.position(now_ms), at=now_ms, rate=rate)
        return [self._state_out(member, "rate", now_ms)]

    def _on_countdown(self, member: Member, msg, now_ms) -> List[Out]:
        denied = self._check_control(member, now_ms)
        if denied:
            return [denied]
        if self.state["src"] is None:
            return [_error(member.id, "no_video", "Сначала загрузите видео")]
        start_at = now_ms + COUNTDOWN_MS
        self.state.update(playing=True, pos=self.position(now_ms), at=start_at)
        return [Out("all", {
            "t": "countdown", "startAt": start_at, "by": member.id, "name": member.name,
            "state": dict(self.state), "now": now_ms,
        })]


# ----------------------------------------------------------------------------
# registry
# ----------------------------------------------------------------------------

class Rooms:
    def __init__(self, max_rooms: int = 2000, max_members: int = 12):
        self.max_rooms = max_rooms
        self.max_members = max_members
        self._rooms: Dict[str, Room] = {}

    def __len__(self) -> int:
        return len(self._rooms)

    def get(self, room_id: str) -> Optional[Room]:
        return self._rooms.get(room_id)

    def get_or_create(self, room_id: str) -> Room:
        room = self._rooms.get(room_id)
        if room is None:
            if len(self._rooms) >= self.max_rooms:
                raise TooManyRooms()
            room = Room(room_id, self.max_members)
            self._rooms[room_id] = room
        return room

    def discard_if_empty(self, room_id: str) -> None:
        room = self._rooms.get(room_id)
        if room is not None and not room.members:
            del self._rooms[room_id]


def now_ms() -> int:
    return int(time.time() * 1000)
