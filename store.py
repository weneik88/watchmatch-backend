"""Tiny SQLite store for users and their settings."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any, Dict, Optional

from settings import sanitize_settings


class Store:
    def __init__(self, path: str = "watchmatch.db"):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock, self._db:
            self._db.execute(
                """CREATE TABLE IF NOT EXISTS users (
                       id         TEXT PRIMARY KEY,
                       email      TEXT NOT NULL,
                       name       TEXT NOT NULL,
                       avatar     TEXT,
                       settings   TEXT NOT NULL DEFAULT '{}',
                       created_at INTEGER NOT NULL,
                       last_login INTEGER NOT NULL
                   )"""
            )

    @staticmethod
    def _row(row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
        if row is None:
            return None
        try:
            settings = sanitize_settings(json.loads(row["settings"]))
        except ValueError:
            settings = {}
        return {
            "id": row["id"],
            "email": row["email"],
            "name": row["name"],
            "avatar": row["avatar"],
            "settings": settings,
        }

    def upsert_google_user(self, sub: str, email: str, name: str, avatar: Optional[str]) -> Dict[str, Any]:
        """Create the account on first sign-in (= registration), refresh it afterwards."""
        uid = f"g_{sub}"
        now = int(time.time())
        with self._lock, self._db:
            self._db.execute(
                """INSERT INTO users (id, email, name, avatar, created_at, last_login)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                       email = excluded.email,
                       name = excluded.name,
                       avatar = excluded.avatar,
                       last_login = excluded.last_login""",
                (uid, email, name, avatar, now, now),
            )
            row = self._db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        return self._row(row)  # type: ignore[return-value]

    def get_user(self, uid: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        return self._row(row)

    def save_settings(self, uid: str, raw_settings: Any) -> Optional[Dict[str, Any]]:
        clean = sanitize_settings(raw_settings)
        with self._lock, self._db:
            cur = self._db.execute(
                "UPDATE users SET settings = ? WHERE id = ?", (json.dumps(clean), uid)
            )
            if cur.rowcount == 0:
                return None
        return clean

    def delete_user(self, uid: str) -> bool:
        with self._lock, self._db:
            return self._db.execute("DELETE FROM users WHERE id = ?", (uid,)).rowcount > 0
