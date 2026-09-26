import os
import json
from typing import Dict, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="WatchMatch backend")

# --- CORS ---
# Set FRONTEND_ORIGIN on your host to your Vercel URL, e.g.
#   FRONTEND_ORIGIN=https://your-frontend.vercel.app
# Comma-separate multiple origins if you have prod + preview deploys.
origins = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# room_id -> set of connected sockets
rooms: Dict[str, Set[WebSocket]] = {}


@app.get("/")
def health():
    return {"status": "ok"}


@app.websocket("/ws/{room_id}")
async def room_socket(websocket: WebSocket, room_id: str):
    await websocket.accept()
    rooms.setdefault(room_id, set()).add(websocket)

    try:
        while True:
            raw = await websocket.receive_text()

            # Validate it's JSON before broadcasting; drop anything else.
            try:
                json.loads(raw)
            except json.JSONDecodeError:
                continue

            # Broadcast to everyone else in the room (not back to sender).
            dead = set()
            for peer in rooms.get(room_id, set()):
                if peer is websocket:
                    continue
                try:
                    await peer.send_text(raw)
                except Exception:
                    dead.add(peer)

            for peer in dead:
                rooms[room_id].discard(peer)

    except WebSocketDisconnect:
        pass
    finally:
        rooms.get(room_id, set()).discard(websocket)
        if not rooms.get(room_id):
            rooms.pop(room_id, None)
