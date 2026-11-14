"""Weather service: live Meteomatics data with caching, quota awareness and
honest failure states.

Rules this module enforces
    * Live data is never silently replaced with synthetic data. If the API
      fails, the last successful dataset is served and labelled "cached"; with
      no cache the bundle is "unavailable" and carries the error.
    * Demo mode is an explicit setting and is always labelled synthetic.
    * Credentials never leave this process and never appear in a payload.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta, timezone
from typing import Callable

import numpy as np

from ..config import Settings
from ..facility import Location
from ..physics import psychro as ps
from ..schemas import WeatherBundle, WeatherError, WeatherHour, WeatherParameter, WeatherQuota
from ..store import Store
from . import demo
from .meteomatics import PARAMETER_BY_ID, PARAMETERS, MeteomaticsClient, MeteomaticsError, TimeSeries

PROVIDER = "Meteomatics Weather API"


def _floor_hour(t: datetime) -> datetime:
    return t.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def _records(series: TimeSeries) -> list[WeatherHour]:
    out = []
    for k, time in enumerate(series.times):
        row: dict = {"time": time}
        for pid, values in series.values.items():
            spec = PARAMETER_BY_ID.get(pid)
            if spec is None or values[k] is None:
                continue
            value = values[k]
            if spec.field == "evaporation_mm":
                # Meteomatics sign convention: negative = evaporation.
                value = max(-value, 0.0)
            row[spec.field] = value
        out.append(WeatherHour(**row))
    return out


def derive_humidity(records: list[WeatherHour], location: Location) -> str:
    """Fill wet-bulb (and RH) from the other humidity parameters when the API
    did not provide them. Returns the wet-bulb provenance."""
    if not records:
        return "unavailable"
    if all(r.wet_bulb_c is not None for r in records):
        return "api"
    default_p = ps.standard_pressure(location.elevation_m)
    derived = False
    for r in records:
        if r.t_2m_c is None:
            continue
        p = r.pressure_hpa * 100.0 if r.pressure_hpa else default_p
        if r.rh_pct is None and r.dew_point_c is not None:
            w = ps.humidity_ratio_from_dew_point(r.dew_point_c, p)
            r.rh_pct = round(float(ps.relative_humidity(r.t_2m_c, w, p)) * 100.0, 1)
        if r.wet_bulb_c is None and r.rh_pct is not None:
            w = ps.humidity_ratio_from_rh(r.t_2m_c, r.rh_pct / 100.0, p)
            r.wet_bulb_c = round(float(ps.wet_bulb(np.array([r.t_2m_c]), w, p)[0]), 2)
            derived = True
    return "derived" if derived else "unavailable"


class WeatherService:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        client_factory: Callable[[], MeteomaticsClient] | None = None,
        now: Callable[[], datetime] | None = None,
    ):
        self.settings = settings
        self.store = store
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._client_factory = client_factory or self._default_client
        self._client: MeteomaticsClient | None = None
        self._lock = threading.Lock()
        self._cache_dir = settings.data_dir / "cache"
        # live dataset state, per location key
        self._dataset: dict | None = None
        self._retry_at: datetime | None = None
        self._error: WeatherError | None = None
        self._quota: WeatherQuota | None = None

    # --- public -----------------------------------------------------------------
    def reconfigure(self, settings: Settings) -> None:
        """Adopt new settings (credentials edited in `.env`) without a restart."""
        with self._lock:
            old = self.settings
            self.settings = settings
            changed = (
                old.meteomatics_username, old.meteomatics_password,
                old.meteomatics_base_url, old.meteomatics_source,
            ) != (
                settings.meteomatics_username, settings.meteomatics_password,
                settings.meteomatics_base_url, settings.meteomatics_source,
            )  # fmt: skip
            if changed:
                if self._client is not None:
                    self._client.close()
                self._client = None
                self._retry_at = None
                self._error = None
                self._quota = None

    def mode(self) -> str:
        stored = self.store.weather_mode()
        if stored in ("live", "demo"):
            return stored
        return "live" if self.settings.meteomatics_configured else "demo"

    def bundle(self, force: bool = False) -> WeatherBundle:
        location = self.store.location()
        if self.mode() == "demo":
            return self._demo_bundle(location)
        with self._lock:
            return self._live_bundle(location, force)

    # --- demo ---------------------------------------------------------------------
    def _demo_bundle(self, location: Location) -> WeatherBundle:
        now = self._now()
        start = _floor_hour(now)
        offset = location.utc_offset_hours
        history = demo.demo_series(start - timedelta(hours=self.settings.history_hours), self.settings.history_hours, offset)
        hourly = demo.demo_series(start, self.settings.forecast_hours + 1, offset)
        return WeatherBundle(
            mode="demo",
            status="demo",
            synthetic=True,
            provider="COOLLOOP synthetic dataset",
            model=demo.LABEL,
            location=location,
            fetched_at=now,
            wet_bulb_source="synthetic",
            current=hourly[0],
            hourly=hourly,
            history=history,
            parameters=[
                WeatherParameter(id=p.id, field=p.field, label=p.label, role=p.role, source="synthetic")
                for p in PARAMETERS
            ],
            notice=demo.NOTICE,
        )

    # --- live -----------------------------------------------------------------------
    def _default_client(self) -> MeteomaticsClient:
        s = self.settings
        return MeteomaticsClient(
            s.meteomatics_base_url, s.meteomatics_username, s.meteomatics_password, s.meteomatics_source
        )

    def _key(self, location: Location) -> str:
        return f"{location.lat:.4f}_{location.lon:.4f}"

    def _live_bundle(self, location: Location, force: bool) -> WeatherBundle:
        now = self._now()
        if not self.settings.meteomatics_configured:
            return WeatherBundle(
                mode="live",
                status="not_configured",
                synthetic=False,
                provider=PROVIDER,
                model=self.settings.meteomatics_source,
                location=location,
                error=WeatherError(
                    kind="not_configured",
                    message=(
                        "Meteomatics credentials are not set. Add METEOMATICS_USERNAME and "
                        "METEOMATICS_PASSWORD to the .env file; they are picked up automatically."
                    ),
                    at=now,
                ),
                notice="No live weather. Switch to demo mode to explore with synthetic data.",
            )

        key = self._key(location)
        if self._dataset is None or self._dataset["key"] != key:
            self._dataset = self._load_disk(key)
            self._retry_at = None
            self._error = None
        dataset = self._dataset
        age = (now - dataset["fetched_at"]).total_seconds() if dataset else None
        fresh = age is not None and age < self.settings.forecast_ttl_s
        waiting = self._retry_at is not None and now < self._retry_at

        if force or not (fresh or waiting):
            try:
                dataset = self._fetch(location, now, dataset)
                self._dataset = dataset
                self._error = None
                self._retry_at = None
                self._save_disk(key, dataset)
            except MeteomaticsError as exc:
                self._error = WeatherError(kind=exc.kind, message=exc.message, at=now, http_status=exc.http_status)
                slow = exc.kind in ("auth", "forbidden", "rate_limited", "quota")
                self._retry_at = now + timedelta(seconds=self.settings.retry_after_error_s * (5 if slow else 1))

        return self._assemble(location, now, dataset)

    def _fetch(self, location: Location, now: datetime, previous: dict | None) -> dict:
        if self._client is None:
            self._client = self._client_factory()
        client = self._client
        self._refresh_quota(client, now)
        quota = self._quota
        if quota and quota.limit_today and quota.used_today is not None:
            if quota.used_today >= quota.limit_today - 2:
                raise MeteomaticsError("quota", "Daily Meteomatics query limit reached; serving cached data.")
        start = _floor_hour(now)
        ids = [p.id for p in PARAMETERS]
        known_missing = (previous or {}).get("unavailable", {})
        if known_missing and (now - previous["checked_at"]).total_seconds() < 12 * 3600:
            ids = [i for i in ids if i not in known_missing]

        forecast = client.available_timeseries(
            start, start + timedelta(hours=self.settings.forecast_hours), ids, location.lat, location.lon
        )
        unavailable = {**(known_missing if len(ids) < len(PARAMETERS) else {}), **forecast.unavailable}
        checked_at = now if forecast.unavailable or not known_missing else previous["checked_at"]
        records = {r.time: r for r in (previous or {}).get("records", []) if r.time < start}
        records.update({r.time: r for r in _records(forecast)})

        # History is optional: subscriptions differ in how far back they allow.
        history_error = None
        history_due = (
            previous is None
            or previous.get("history_at") is None
            or (now - previous["history_at"]).total_seconds() > self.settings.history_ttl_s
        )
        history_at = (previous or {}).get("history_at")
        if history_due:
            try:
                past = client.timeseries(
                    start - timedelta(hours=self.settings.history_hours),
                    start - timedelta(hours=1),
                    [i for i in ids if i not in unavailable],
                    location.lat,
                    location.lon,
                )
                records.update({r.time: r for r in _records(past)})
                history_at = now
            except MeteomaticsError as exc:
                history_error = exc.message

        cutoff = start - timedelta(hours=self.settings.history_hours)
        ordered = [records[t] for t in sorted(records) if t >= cutoff]
        return {
            "key": self._key(location),
            "fetched_at": now,
            "api_generated_at": forecast.generated_at,
            "records": ordered,
            "unavailable": unavailable,
            "checked_at": checked_at,
            "history_at": history_at,
            "history_error": history_error,
        }

    def _refresh_quota(self, client: MeteomaticsClient, now: datetime) -> None:
        quota = self._quota
        if quota and quota.checked_at and (now - quota.checked_at).total_seconds() < self.settings.quota_ttl_s:
            return
        try:
            self._quota = client.user_stats()
        except (MeteomaticsError, ValueError, AttributeError, TypeError):
            pass  # quota reporting is best effort and must never block weather

    def _assemble(self, location: Location, now: datetime, dataset: dict | None) -> WeatherBundle:
        base = dict(
            mode="live", synthetic=False, provider=PROVIDER,
            model=self.settings.meteomatics_source, location=location,
            error=self._error, quota=self._quota,
        )  # fmt: skip
        start = _floor_hour(now)
        records = [r.model_copy() for r in (dataset or {}).get("records", [])]
        hourly = [r for r in records if r.time >= start]
        if not dataset or not hourly:
            return WeatherBundle(
                **base,
                status="unavailable",
                last_success_at=dataset["fetched_at"] if dataset else None,
                notice="Live weather is unavailable and there is no usable cached forecast.",
            )
        wet_bulb_source = derive_humidity(records, location)
        unavailable = dataset.get("unavailable", {})
        parameters = []
        for p in PARAMETERS:
            if p.id not in unavailable:
                source, detail = "api", ""
            elif p.field == "wet_bulb_c" and wet_bulb_source == "derived":
                source = "derived"
                detail = "Not in this subscription; derived from temperature and humidity (ASHRAE)."
            else:
                source, detail = "unavailable", unavailable[p.id]
            parameters.append(
                WeatherParameter(id=p.id, field=p.field, label=p.label, role=p.role, source=source, detail=detail)
            )
        failed = self._error is not None
        age = (now - dataset["fetched_at"]).total_seconds()
        notices = []
        if failed:
            notices.append("Live update failed. Showing the last successful Meteomatics forecast.")
        if dataset.get("history_error"):
            notices.append(f"History not available: {dataset['history_error']}")
        return WeatherBundle(
            **base,
            status="cached" if failed else "live",
            stale=failed or age > 2 * self.settings.forecast_ttl_s,
            fetched_at=dataset["fetched_at"],
            last_success_at=dataset["fetched_at"],
            api_generated_at=dataset.get("api_generated_at"),
            next_refresh_at=self._retry_at or dataset["fetched_at"] + timedelta(seconds=self.settings.forecast_ttl_s),
            wet_bulb_source=wet_bulb_source,
            current=hourly[0],
            hourly=hourly,
            history=[r for r in records if r.time < start],
            parameters=parameters,
            notice=" ".join(notices),
        )

    # --- disk cache -------------------------------------------------------------------
    def _disk_path(self, key: str):
        return self._cache_dir / f"meteomatics_{key}.json"

    def _save_disk(self, key: str, dataset: dict) -> None:
        try:
            self._cache_dir.mkdir(parents=True, exist_ok=True)
            payload = {
                **{k: v for k, v in dataset.items() if k != "records"},
                "records": [r.model_dump(mode="json") for r in dataset["records"]],
            }
            self._disk_path(key).write_text(json.dumps(payload, default=str), encoding="utf-8")
        except OSError:
            pass

    def _load_disk(self, key: str) -> dict | None:
        path = self._disk_path(key)
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))

            def when(value):
                return datetime.fromisoformat(value) if value else None

            return {
                "key": key,
                "fetched_at": when(raw["fetched_at"]),
                "api_generated_at": when(raw.get("api_generated_at")),
                "records": [WeatherHour.model_validate(r) for r in raw["records"]],
                "unavailable": raw.get("unavailable", {}),
                "checked_at": when(raw.get("checked_at")) or when(raw["fetched_at"]),
                "history_at": when(raw.get("history_at")),
                "history_error": raw.get("history_error"),
            }
        except (OSError, ValueError, KeyError, TypeError):
            return None
