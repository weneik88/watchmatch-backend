import asyncio
import json
import logging
import os
import secrets
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from fastapi import Body, Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from auth import AuthError, GoogleVerifier, bearer, make_token, verify_token
from identity import LoginRequired, resolve_identity
from rooms import ROOM_ID_RE, Member, Out, Room, RoomFull, Rooms, TooManyRooms, now_ms
from store import Store

log = logging.getLogger("watchmatch")

# --- configuration (all through environment variables) -------------------------
#
#   FRONTEND_ORIGIN   comma separated list of allowed site origins, e.g.
#                     https://watchmatchh.vercel.app,http://localhost:3000
#   GOOGLE_CLIENT_ID  OAuth "Web application" client id. Sign-in is mandatory, so
#                     without it nobody can create or join a room
#   SESSION_SECRET    long random string used to sign session tokens. If unset a
#                     random one is generated on every start, which logs everybody out
#                     on each restart
#   DB_PATH           SQLite file (default watchmatch.db)
#   MAX_MEMBERS       people per room (default 12)

ORIGINS = [o.strip() for o in os.getenv("FRONTEND_ORIGIN", "http://localhost:3000").split(",") if o.strip()]
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()
MAX_MEMBERS = int(os.getenv("MAX_MEMBERS", "12"))
MAX_MESSAGE = 4096

_secret_env = os.getenv("SESSION_SECRET", "")
if not _secret_env:
    log.warning("SESSION_SECRET is not set: using a random one, sessions reset on restart")
SECRET = (_secret_env or secrets.token_urlsafe(48)).encode("utf-8")

store = Store(os.getenv("DB_PATH", "watchmatch.db"))
verifier = GoogleVerifier(GOOGLE_CLIENT_ID) if GOOGLE_CLIENT_ID else None
if verifier is None:
    log.warning("GOOGLE_CLIENT_ID is not set: sign-in is required, so nobody can enter a room")
rooms = Rooms(max_members=MAX_MEMBERS)

app = FastAPI(title="WatchMatch backend")

# CORS covers normal HTTP requests. Browsers do NOT apply it to WebSockets,
# which is why the websocket handler checks the Origin header itself.
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_credentials=False,  # we use a Bearer header, not cookies
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


# --- HTTP ------------------------------------------------------------------------

def public_user(user: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": user["id"],
        "name": user["name"],
        "email": user["email"],
        "avatar": user["avatar"],
        "settings": user["settings"],
    }


async def current_user(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    uid = verify_token(bearer(authorization), SECRET)
    user = await asyncio.to_thread(store.get_user, uid) if uid else None
    if not user:
        raise HTTPException(status_code=401, detail="Not signed in")
    return user


@app.get("/")
def health():
    return {"status": "ok"}


@app.get("/config")
def config():
    return {"googleClientId": GOOGLE_CLIENT_ID or None, "maxMembers": MAX_MEMBERS}


@app.post("/auth/google")
async def auth_google(payload: Dict[str, Any] = Body(...)):
    """Sign in or register (first sign-in creates the account)."""
    if verifier is None:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured")
    try:
        info = await asyncio.to_thread(verifier.verify, payload.get("credential"))
    except AuthError as exc:
        log.info("google sign-in rejected: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid Google credential")
    user = await asyncio.to_thread(
        store.upsert_google_user, info["sub"], info["email"], info["name"], info["picture"]
    )
    return {"token": make_token(user["id"], SECRET), "user": public_user(user)}


@app.get("/me")
async def me(user: Dict[str, Any] = Depends(current_user)):
    return public_user(user)


@app.put("/me/settings")
async def put_settings(raw: Dict[str, Any] = Body(...), user: Dict[str, Any] = Depends(current_user)):
    saved = await asyncio.to_thread(store.save_settings, user["id"], raw)
    if saved is None:
        raise HTTPException(status_code=404, detail="User not found")
    return {"settings": saved}


@app.delete("/me")
async def delete_me(user: Dict[str, Any] = Depends(current_user)):
    await asyncio.to_thread(store.delete_user, user["id"])
    return {"deleted": True}


# --- WebSocket -----------------------------------------------------------------

class Conn:
    """One lock per socket so two broadcasts never interleave on the same connection."""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.lock = asyncio.Lock()

    async def send(self, text: str) -> None:
        async with self.lock:
            await asyncio.wait_for(self.ws.send_text(text), timeout=5)


def origin_allowed(origin: Optional[str], host: Optional[str]) -> bool:
    if "*" in ORIGINS:
        return True
    if origin is None:
        return True  # not a browser (curl, tests, bots): CSWSH is a browser-only attack
    if origin in ORIGINS:
        return True
    # the frontend served by this very backend under /app
    return bool(host) and urlparse(origin).netloc == host


async def deliver(room: Room, outs: list) -> None:
    """Send messages; members whose socket fails are removed (which may queue more messages)."""
    pending = list(outs)
    while pending:
        out: Out = pending.pop(0)
        if out.to == "all":
            targets = [m for m in room.members.values() if m.id != out.exclude]
        else:
            m = room.members.get(out.to)
            targets = [m] if m else []
        if not targets:
            continue
        data = json.dumps(out.payload, ensure_ascii=False, separators=(",", ":"))
        results = await asyncio.gather(*(m.conn.send(data) for m in targets), return_exceptions=True)
        for m, result in zip(targets, results):
            if isinstance(result, Exception):
                pending.extend(room.remove_member(m.id, now_ms()))


async def fatal(ws: WebSocket, code: str, message: str) -> None:
    try:
        await ws.send_text(json.dumps({"t": "error", "code": code, "message": message, "fatal": True},
                                      ensure_ascii=False))
        await ws.close(code=1008)
    except Exception:
        pass


@app.websocket("/ws/{room_id}")
async def room_socket(websocket: WebSocket, room_id: str):
    if not ROOM_ID_RE.match(room_id) or not origin_allowed(
        websocket.headers.get("origin"), websocket.headers.get("host")
    ):
        await websocket.close(code=1008)
        return

    await websocket.accept()
    room: Optional[Room] = None
    member: Optional[Member] = None

    try:
        # The first message must be {"t":"hello", ...} within 10 seconds.
        try:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)
            hello = json.loads(raw) if len(raw) <= MAX_MESSAGE else None
        except (asyncio.TimeoutError, ValueError):
            hello = None
        if not isinstance(hello, dict) or hello.get("t") != "hello":
            await fatal(websocket, "bad_hello", "Ожидалось приветствие")
            return

        # Sign-in is mandatory. This happens before the room is created, so an
        # anonymous client can neither create nor join a room.
        try:
            name, avatar, user_id = await asyncio.to_thread(resolve_identity, hello, SECRET, store.get_user)
        except LoginRequired:
            await fatal(websocket, "login_required", "Войдите через Google, чтобы зайти в комнату")
            return

        try:
            room = rooms.get_or_create(room_id)
        except TooManyRooms:
            await fatal(websocket, "busy", "Сервер перегружен, попробуйте позже")
            return

        member = Member(id=secrets.token_hex(4), name=name, avatar=avatar, user_id=user_id,
                        conn=Conn(websocket))
        try:
            outs = room.add_member(member, now_ms())
        except RoomFull:
            member = None
            await fatal(websocket, "full", "В комнате нет мест")
            return
        await deliver(room, outs)

        strikes = 0
        while True:
            raw = await websocket.receive_text()
            if len(raw) > MAX_MESSAGE:
                strikes += 5
            else:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    msg = None
                    strikes += 2
                if msg is not None:
                    outs = room.handle(member.id, msg, now_ms())
                    if member.buckets["any"].tokens < 1:  # flooding
                        strikes += 1
                    elif strikes and member.buckets["any"].tokens > 10:
                        strikes -= 1
                    if outs:
                        await deliver(room, outs)
            if strikes > 200:
                await websocket.close(code=1008)
                return

    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("websocket error in room %s", room_id)
    finally:
        if room is not None:
            if member is not None and member.id in room.members:
                await deliver(room, room.remove_member(member.id, now_ms()))
            rooms.discard_if_empty(room_id)


# --- frontend, for local development: http://localhost:8000/app/ ---------------
_frontend = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")
if os.path.isdir(_frontend):
    app.mount("/app", StaticFiles(directory=_frontend, html=True), name="frontend")
