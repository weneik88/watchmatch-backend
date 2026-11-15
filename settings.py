"""Validation of per-user interface settings.

Settings are stored per Google account so the look follows the user to
another device. The server only keeps values it understands and silently
drops the rest, so a client can never stuff arbitrary data into the DB.
"""
from __future__ import annotations

import re
from typing import Any, Dict

THEMES = ("aurora", "midnight", "sunset", "ocean", "sakura", "mint", "graphite")
MOTIONS = ("full", "calm", "off")
BACKGROUNDS = ("blobs", "stars", "grid", "none")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_NICK = 24


def _int_in(value: Any, lo: int, hi: int):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value:  # NaN
        return None
    return int(min(max(value, lo), hi))


def sanitize_settings(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Any] = {}

    if raw.get("theme") in THEMES:
        out["theme"] = raw["theme"]
    if isinstance(raw.get("accent"), str) and HEX_RE.match(raw["accent"]):
        out["accent"] = raw["accent"].lower()
    if raw.get("motion") in MOTIONS:
        out["motion"] = raw["motion"]
    if raw.get("bg") in BACKGROUNDS:
        out["bg"] = raw["bg"]

    for key, lo, hi in (("blur", 0, 60), ("glass", 2, 45), ("radius", 6, 38)):
        if key in raw:
            v = _int_in(raw[key], lo, hi)
            if v is not None:
                out[key] = v

    for key in ("confetti", "sound", "cinema"):
        if isinstance(raw.get(key), bool):
            out[key] = raw[key]

    if isinstance(raw.get("nickname"), str):
        nick = re.sub(r"[\x00-\x1f\x7f]", "", raw["nickname"])
        nick = re.sub(r"\s+", " ", nick).strip()[:MAX_NICK]
        out["nickname"] = nick

    return out
