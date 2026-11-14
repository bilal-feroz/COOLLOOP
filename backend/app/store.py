"""Lightweight local persistence: one JSON file, no database.

Holds the applied operating configuration, the site settings and the audit
log of operator decisions.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from .facility import BASELINE_CONFIG, Location, OperatingConfig
from .schemas import AuditEntry


class Store:
    def __init__(self, path: Path, default_location: Location):
        self._path = path
        self._lock = threading.Lock()
        self._default_location = default_location
        self._state: dict = {}
        if path.exists():
            try:
                self._state = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                self._state = {}

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._state, indent=2, default=str), encoding="utf-8")
        tmp.replace(self._path)

    # --- operating configuration ----------------------------------------------
    def config(self) -> OperatingConfig:
        with self._lock:
            raw = self._state.get("config")
        if raw:
            try:
                return OperatingConfig.model_validate(raw)
            except ValueError:
                pass
        return BASELINE_CONFIG.model_copy()

    def config_meta(self) -> dict:
        with self._lock:
            return dict(
                self._state.get("config_meta")
                or {"applied_at": None, "source": "reference baseline", "approved_by": None}
            )

    def apply_config(self, cfg: OperatingConfig, entry: AuditEntry) -> None:
        with self._lock:
            self._state["config"] = cfg.model_dump()
            self._state["config_meta"] = {
                "applied_at": entry.at.isoformat(),
                "source": entry.source,
                "approved_by": entry.approved_by,
            }
            self._state.setdefault("audit", []).append(entry.model_dump(mode="json"))
            self._state["audit"] = self._state["audit"][-200:]
            self._save()

    def log(self, entry: AuditEntry) -> None:
        with self._lock:
            self._state.setdefault("audit", []).append(entry.model_dump(mode="json"))
            self._state["audit"] = self._state["audit"][-200:]
            self._save()

    def audit(self, limit: int = 30) -> list[AuditEntry]:
        with self._lock:
            raw = list(self._state.get("audit", []))[-limit:]
        return [AuditEntry.model_validate(r) for r in reversed(raw)]

    # --- site settings -----------------------------------------------------------
    def location(self) -> Location:
        with self._lock:
            raw = self._state.get("location")
        if raw:
            try:
                return Location.model_validate(raw)
            except ValueError:
                pass
        return self._default_location.model_copy()

    def set_location(self, location: Location) -> None:
        with self._lock:
            self._state["location"] = location.model_dump()
            self._save()

    def weather_mode(self) -> str | None:
        with self._lock:
            return self._state.get("weather_mode")

    def set_weather_mode(self, mode: str) -> None:
        with self._lock:
            self._state["weather_mode"] = mode
            self._save()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
