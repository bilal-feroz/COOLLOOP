"""Client for the Meteomatics Weather API.

Request format (https://www.meteomatics.com/en/api/getting-started/):

    {base}/{validdatetime}/{parameters}/{lat},{lon}/{format}?source={model}

    validdatetime   2026-11-14T10:00:00Z--2026-11-21T10:00:00Z:PT1H
    parameters      comma-separated identifiers such as t_2m:C
    format          json

Authentication is HTTP Basic with the account credentials. They stay on the
server: this module is the only place that sends them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

import httpx

from ..schemas import WeatherQuota


@dataclass(frozen=True)
class ParameterSpec:
    id: str  # Meteomatics identifier
    field: str  # WeatherHour field
    label: str
    role: str  # what the simulation uses it for
    essential: bool = False


# Documented identifiers. `source=mix` is the globally available blend, so the
# UAE is covered (EURO1k / US1k are regional and are not used).
PARAMETERS: tuple[ParameterSpec, ...] = (
    ParameterSpec(
        "t_2m:C", "t_2m_c", "Air temperature",
        "Dry-plant condensing, tower sensible/latent split, envelope gain", essential=True,
    ),
    ParameterSpec(
        "wet_bulb_t_2m:C", "wet_bulb_c", "Wet-bulb temperature",
        "Cooling-tower inlet air state and approach",
    ),
    ParameterSpec(
        "relative_humidity_2m:p", "rh_pct", "Relative humidity",
        "Humidity of the inlet air; wet-bulb fallback",
    ),
    ParameterSpec("dew_point_2m:C", "dew_point_c", "Dew point", "Wet-bulb fallback"),
    ParameterSpec(
        "wind_speed_10m:ms", "wind_ms", "Wind speed", "External surface film of the envelope"
    ),
    ParameterSpec(
        "global_rad:W", "global_rad_w_m2", "Global radiation", "Solar gain on the roof (sol-air)"
    ),
    ParameterSpec(
        "precip_1h:mm", "precip_mm", "Precipitation", "Context only; rain is not credited as makeup"
    ),
    ParameterSpec(
        "evaporation_1h:mm", "evaporation_mm", "Surface evaporation",
        "Context only; never used as tower evaporation",
    ),
    ParameterSpec(
        "sfc_pressure:hPa", "pressure_hpa", "Surface pressure", "Barometric pressure for psychrometrics"
    ),
)  # fmt: skip

PARAMETER_BY_ID = {p.id: p for p in PARAMETERS}


class MeteomaticsError(Exception):
    """A failed API call, classified so the UI can explain it."""

    def __init__(self, kind: str, message: str, http_status: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.http_status = http_status


@dataclass
class TimeSeries:
    times: list[datetime]
    values: dict[str, list[float | None]]  # keyed by Meteomatics identifier
    generated_at: datetime | None = None
    unavailable: dict[str, str] = field(default_factory=dict)  # identifier -> reason


def _stamp(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_time(text: str | None) -> datetime | None:
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _error_text(response: httpx.Response) -> str:
    try:
        body = response.json()
        if isinstance(body, dict):
            for key in ("message", "error", "detail"):
                if body.get(key):
                    return str(body[key])[:300]
    except ValueError:
        pass
    text = re.sub(r"<[^>]+>", " ", response.text or "")
    return re.sub(r"\s+", " ", text).strip()[:300] or response.reason_phrase


class MeteomaticsClient:
    def __init__(
        self,
        base_url: str,
        username: str,
        password: str,
        source: str = "mix",
        timeout: float = 20.0,
        transport: httpx.BaseTransport | None = None,
    ):
        self.source = source
        self.requests_made = 0
        self._http = httpx.Client(
            base_url=base_url.rstrip("/"),
            auth=(username, password),
            timeout=timeout,
            transport=transport,
        )

    def close(self) -> None:
        self._http.close()

    def _get(self, path: str, params: dict | None = None) -> httpx.Response:
        self.requests_made += 1
        try:
            response = self._http.get(path, params=params)
        except httpx.TimeoutException as exc:
            raise MeteomaticsError("timeout", "Meteomatics did not respond in time.") from exc
        except httpx.TransportError as exc:
            raise MeteomaticsError("network", f"Could not reach Meteomatics: {exc}") from exc
        status = response.status_code
        if status < 400:
            return response
        detail = _error_text(response)
        if status == 401:
            raise MeteomaticsError("auth", "Meteomatics rejected the credentials.", status)
        if status == 403:
            raise MeteomaticsError("forbidden", f"Not permitted for this account: {detail}", status)
        if status == 429:
            raise MeteomaticsError("rate_limited", f"Meteomatics rate limit reached: {detail}", status)
        if status >= 500:
            raise MeteomaticsError("server", f"Meteomatics server error {status}: {detail}", status)
        raise MeteomaticsError("bad_request", f"Request rejected ({status}): {detail}", status)

    def timeseries(
        self,
        start: datetime,
        end: datetime,
        parameters: list[str],
        lat: float,
        lon: float,
        step: str = "PT1H",
    ) -> TimeSeries:
        """Point time series for one location."""
        when = _stamp(start) if start == end else f"{_stamp(start)}--{_stamp(end)}:{step}"
        path = f"/{when}/{','.join(parameters)}/{lat:.4f},{lon:.4f}/json"
        response = self._get(path, {"source": self.source})
        try:
            body = response.json()
            if body.get("status", "OK") != "OK":
                raise MeteomaticsError("api", f"Meteomatics status {body.get('status')}")
            times: list[datetime] = []
            values: dict[str, list[float | None]] = {}
            for block in body["data"]:
                dates = block["coordinates"][0]["dates"]
                if not times:
                    times = [t for t in (_parse_time(d["date"]) for d in dates) if t]
                series = []
                for d in dates:
                    v = d.get("value")
                    series.append(float(v) if isinstance(v, (int, float)) else None)
                values[block["parameter"]] = series
        except MeteomaticsError:
            raise
        except (KeyError, IndexError, TypeError, ValueError, AttributeError) as exc:
            raise MeteomaticsError("parse", "Unexpected response format from Meteomatics.") from exc
        if not times or any(len(v) != len(times) for v in values.values()):
            raise MeteomaticsError("parse", "Meteomatics returned an incomplete time series.")
        return TimeSeries(times, values, _parse_time(body.get("dateGenerated")))

    def available_timeseries(
        self,
        start: datetime,
        end: datetime,
        parameters: list[str],
        lat: float,
        lon: float,
    ) -> TimeSeries:
        """Like `timeseries`, but verifies each parameter when the combined
        request is rejected, drops the ones this account cannot access and
        reports why. Essential parameters are never dropped silently."""
        try:
            return self.timeseries(start, end, parameters, lat, lon)
        except MeteomaticsError as exc:
            if exc.kind not in ("bad_request", "forbidden") or len(parameters) < 2:
                raise
            first_error = exc

        usable, unavailable = [], {}
        for pid in parameters:
            try:
                self.timeseries(start, start, [pid], lat, lon)
                usable.append(pid)
            except MeteomaticsError as exc:
                if exc.kind not in ("bad_request", "forbidden"):
                    raise
                unavailable[pid] = exc.message
        missing_essential = [p for p in unavailable if PARAMETER_BY_ID.get(p) and PARAMETER_BY_ID[p].essential]
        if not usable or missing_essential or not unavailable:
            # Nothing usable, or the rejection was not about a parameter
            # (for example a time range outside the subscription).
            raise first_error
        series = self.timeseries(start, end, usable, lat, lon)
        series.unavailable = unavailable
        return series

    def user_stats(self) -> WeatherQuota:
        """Query limits from `/user_stats_json` (best effort, tolerant parsing)."""
        body = self._get("/user_stats_json").json()
        stats = body.get("user statistics", body) if isinstance(body, dict) else {}
        if isinstance(stats, list):
            stats = stats[0] if stats else {}

        def pick(prefix: str) -> tuple[int | None, int | None]:
            for key, value in stats.items():
                if key.lower().startswith(prefix) and isinstance(value, dict):
                    used, limit = value.get("used"), value.get("hard limit")
                    return (
                        int(used) if isinstance(used, (int, float)) else None,
                        int(limit) if isinstance(limit, (int, float)) and limit > 0 else None,
                    )
            return None, None

        used_day, limit_day = pick("requests since last utc midnight")
        used_min, limit_min = pick("requests in the last 60 seconds")
        # The account reports history either as a flag or as a date range.
        historic = stats.get("historic request option")
        if isinstance(historic, bool):
            historic_access, historic_range = historic, None
        elif isinstance(historic, str) and historic.strip():
            historic_access, historic_range = True, historic.strip()
        else:
            historic_access, historic_range = None, None
        plan = stats.get("mix type")
        return WeatherQuota(
            used_today=used_day,
            limit_today=limit_day,
            used_minute=used_min,
            limit_minute=limit_min,
            historic_access=historic_access,
            historic_range=historic_range,
            plan=plan if isinstance(plan, str) and plan else None,
            valid_until=_parse_time(stats.get("hard deadline") if isinstance(stats.get("hard deadline"), str) else None),
            checked_at=datetime.now(timezone.utc),
        )
