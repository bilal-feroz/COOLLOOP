"""Weather service: live Meteomatics data with caching, quota awareness and
honest failure states, plus replay of real past weather.

Rules this module enforces
    * Live data is never silently replaced with synthetic data. If the API
      fails, the last successful dataset is served and labelled "cached"; with
      no cache the bundle is "unavailable" and carries the error.
    * Demo mode is an explicit setting and is always labelled synthetic.
    * Replay mode serves real historical Meteomatics data for a chosen moment
      and is always labelled as past conditions.
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
from ..schemas import (
    WeatherBundle,
    WeatherError,
    WeatherExtreme,
    WeatherExtremes,
    WeatherHour,
    WeatherParameter,
    WeatherQuota,
)
from ..store import Store
from . import demo
from .meteomatics import PARAMETER_BY_ID, PARAMETERS, MeteomaticsClient, MeteomaticsError, TimeSeries

PROVIDER = "Meteomatics Weather API"
SCAN_DAYS = 365  # how far back the search for extreme hours looks
REPLAY_LEAD_HOURS = 12  # a replay of an extreme starts this long before it
_DERIVED_NOTE = "Not in this subscription; derived from temperature and humidity (ASHRAE)."


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


def _parameter_rows(unavailable: dict, wet_bulb_source: str) -> list[WeatherParameter]:
    rows = []
    for p in PARAMETERS:
        if p.id not in unavailable:
            source, detail = "api", ""
        elif p.field == "wet_bulb_c" and wet_bulb_source == "derived":
            source, detail = "derived", _DERIVED_NOTE
        else:
            source, detail = "unavailable", unavailable[p.id]
        rows.append(WeatherParameter(id=p.id, field=p.field, label=p.label, role=p.role, source=source, detail=detail))
    return rows


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
        # replay dataset state, per location and replay hour
        self._replay: dict | None = None
        self._replay_error: tuple[str, WeatherError, datetime] | None = None
        self._extremes: tuple[str, WeatherExtremes] | None = None

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
                self._replay_error = None

    def mode(self) -> str:
        stored = self.store.weather_mode()
        if stored in ("live", "demo", "replay"):
            return stored
        return "live" if self.settings.meteomatics_configured else "demo"

    def bundle(self, force: bool = False) -> WeatherBundle:
        location = self.store.location()
        mode = self.mode()
        if mode == "demo":
            return self._demo_bundle(location)
        with self._lock:
            if mode == "replay":
                return self._replay_bundle(location, force)
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

    # --- shared ---------------------------------------------------------------------
    def _default_client(self) -> MeteomaticsClient:
        s = self.settings
        return MeteomaticsClient(
            s.meteomatics_base_url, s.meteomatics_username, s.meteomatics_password, s.meteomatics_source
        )

    def _key(self, location: Location) -> str:
        return f"{location.lat:.4f}_{location.lon:.4f}"

    def _ready_client(self, now: datetime) -> MeteomaticsClient:
        """The API client, after checking the daily quota."""
        if self._client is None:
            self._client = self._client_factory()
        self._refresh_quota(self._client, now)
        quota = self._quota
        if quota and quota.limit_today and quota.used_today is not None:
            if quota.used_today >= quota.limit_today - 2:
                raise MeteomaticsError("quota", "Daily Meteomatics query limit reached; serving cached data.")
        return self._client

    def _not_configured(self, location: Location, mode: str, now: datetime) -> WeatherBundle:
        return WeatherBundle(
            mode=mode,
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

    def _refresh_quota(self, client: MeteomaticsClient, now: datetime) -> None:
        quota = self._quota
        if quota and quota.checked_at and (now - quota.checked_at).total_seconds() < self.settings.quota_ttl_s:
            return
        try:
            self._quota = client.user_stats()
        except (MeteomaticsError, ValueError, AttributeError, TypeError):
            pass  # quota reporting is best effort and must never block weather

    # --- live -----------------------------------------------------------------------
    def _live_bundle(self, location: Location, force: bool) -> WeatherBundle:
        now = self._now()
        if not self.settings.meteomatics_configured:
            return self._not_configured(location, "live", now)

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
        client = self._ready_client(now)
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
            parameters=_parameter_rows(dataset.get("unavailable", {}), wet_bulb_source),
            notice=" ".join(notices),
        )

    # --- replay of real past weather ----------------------------------------------------
    def _replay_bundle(self, location: Location, force: bool) -> WeatherBundle:
        """Real Meteomatics data around a chosen past moment. The moment acts as
        "now": the hours before it are history, the hours after it play the
        part of the forecast."""
        now = self._now()
        if not self.settings.meteomatics_configured:
            return self._not_configured(location, "replay", now)
        base = dict(
            mode="replay", synthetic=False, provider=PROVIDER,
            model=self.settings.meteomatics_source, location=location, quota=self._quota,
        )  # fmt: skip
        chosen = self.store.replay_at()
        if chosen is None:
            return WeatherBundle(
                **base,
                status="unavailable",
                error=WeatherError(kind="replay", message="Choose a date and time to replay.", at=now),
                notice="No replay period is selected.",
            )
        at = _floor_hour(chosen)
        history = timedelta(hours=self.settings.history_hours)
        ahead = timedelta(hours=self.settings.forecast_hours)
        # One request covers every moment of the chosen day, so stepping
        # through a replay hour by hour costs nothing more.
        day = at.replace(hour=0)
        span_start, span_end = day - history, day + timedelta(hours=23) + ahead
        key = f"replay_{self._key(location)}_{day:%Y%m%d}"
        if self._replay is None or self._replay["key"] != key:
            self._replay = self._load_disk(key)
        data = self._replay

        # Past weather does not change. A period retrieved before all of it had
        # happened still ends in forecast hours, which are refreshed like live data.
        covers = data is not None and any(r.time == at for r in data["records"])
        settled = covers and data["fetched_at"] >= span_end
        age = (now - data["fetched_at"]).total_seconds() if data else None
        due = not covers or (not settled and (force or age > self.settings.forecast_ttl_s))
        failure = self._replay_error if self._replay_error and self._replay_error[0] == key else None
        waiting = failure is not None and now < failure[2]
        if due and (force or not waiting):
            try:
                client = self._ready_client(now)
                series = client.available_timeseries(
                    span_start, span_end, [p.id for p in PARAMETERS], location.lat, location.lon
                )
                data = {
                    "key": key, "fetched_at": now, "api_generated_at": series.generated_at,
                    "records": _records(series), "unavailable": series.unavailable,
                    "checked_at": now, "history_at": now, "history_error": None,
                }  # fmt: skip
                self._replay = data
                self._replay_error = failure = None
                self._save_disk(key, data)
            except MeteomaticsError as exc:
                error = WeatherError(kind=exc.kind, message=exc.message, at=now, http_status=exc.http_status)
                failure = (key, error, now + timedelta(seconds=self.settings.retry_after_error_s))
                self._replay_error = failure

        base["quota"] = self._quota
        error = failure[1] if failure else None
        records = [r.model_copy() for r in (data or {}).get("records", []) if at - history <= r.time <= at + ahead]
        hourly = [r for r in records if r.time >= at]
        if not hourly or hourly[0].time != at:
            return WeatherBundle(
                **base,
                status="unavailable",
                replay_at=at,
                error=error,
                notice="The replay period could not be retrieved. No substitute data is shown.",
            )
        wet_bulb_source = derive_humidity(records, location)
        local = at + timedelta(hours=location.utc_offset_hours)
        notice = (
            f"Replay of historical Meteomatics data from {local:%a %d %b %Y %H:%M} site time. "
            "Past conditions replayed as if they were now: not the current weather and not a forecast."
        )
        if hourly[-1].time > now:
            notice += " The period runs past the present, so its last hours come from today's forecast."
        return WeatherBundle(
            **base,
            status="replay",
            replay_at=at,
            error=error,
            fetched_at=data["fetched_at"],
            last_success_at=data["fetched_at"],
            api_generated_at=data.get("api_generated_at"),
            wet_bulb_source=wet_bulb_source,
            current=hourly[0],
            hourly=hourly,
            history=[r for r in records if r.time < at],
            parameters=_parameter_rows(data.get("unavailable", {}), wet_bulb_source),
            notice=notice,
        )

    def extremes(self) -> WeatherExtremes:
        """Scan the past year for the hours that stress the plant most. One
        hourly request; the result is kept for a day."""
        location = self.store.location()
        with self._lock:
            now = self._now()
            if not self.settings.meteomatics_configured:
                raise MeteomaticsError("not_configured", "Meteomatics credentials are not set.")
            key = f"extremes_{self._key(location)}"
            if self._extremes is None or self._extremes[0] != key:
                self._extremes = self._load_extremes(key)
            if self._extremes and (now - self._extremes[1].scanned_to).total_seconds() < 24 * 3600:
                return self._extremes[1]

            client = self._ready_client(now)
            end = _floor_hour(now)
            start = end - timedelta(days=SCAN_DAYS)
            series = client.available_timeseries(
                start, end, ["t_2m:C", "wet_bulb_t_2m:C", "relative_humidity_2m:p"], location.lat, location.lon
            )

            def column(pid: str) -> np.ndarray | None:
                values = series.values.get(pid)
                return None if values is None else np.array([np.nan if v is None else v for v in values], dtype=float)

            t = column("t_2m:C")
            rh = column("relative_humidity_2m:p")
            wb = column("wet_bulb_t_2m:C")
            if t is None or (wb is None and rh is None):
                raise MeteomaticsError("parameter", "The account does not provide temperature and humidity history.")
            if wb is None:
                p = ps.standard_pressure(location.elevation_m)
                wb = ps.wet_bulb(t, ps.humidity_ratio_from_rh(t, np.clip(rh, 1.0, 100.0) / 100.0, p), p)
            if not np.isfinite(t + wb).any():
                raise MeteomaticsError("parse", "Meteomatics returned no usable history for this site.")

            def pick(kind: str, score: np.ndarray, label: str, detail: str) -> WeatherExtreme:
                i = int(np.nanargmax(score))
                return WeatherExtreme(
                    kind=kind, label=label, detail=detail, time=series.times[i],
                    replay_from=series.times[i] - timedelta(hours=REPLAY_LEAD_HOURS),
                    t_2m_c=round(float(t[i]), 1), wet_bulb_c=round(float(wb[i]), 1),
                    rh_pct=None if rh is None or np.isnan(rh[i]) else round(float(rh[i]), 0),
                )  # fmt: skip

            result = WeatherExtremes(
                scanned_from=start,
                scanned_to=end,
                hours=len(series.times),
                source=f"{PROVIDER} ({self.settings.meteomatics_source})",
                extremes=[
                    pick("wet_bulb", wb, "Highest wet-bulb", "Humid heat: the hardest hour for the cooling towers."),
                    pick("dry_bulb", t, "Highest dry-bulb", "Peak heat: the hardest hour for the air-cooled plant."),
                    pick("dry_air", t - wb, "Driest heat", "Largest gap between dry-bulb and wet-bulb: the most evaporation per unit of heat."),
                ],
            )
            self._extremes = (key, result)
            try:
                self._cache_dir.mkdir(parents=True, exist_ok=True)
                (self._cache_dir / f"{key}.json").write_text(result.model_dump_json(), encoding="utf-8")
            except OSError:
                pass
            return result

    def _load_extremes(self, key: str) -> tuple[str, WeatherExtremes] | None:
        path = self._cache_dir / f"{key}.json"
        try:
            return (key, WeatherExtremes.model_validate_json(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return None

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
