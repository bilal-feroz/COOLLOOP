"""Deterministic SYNTHETIC weather for demo mode.

A repeating seven-day peak-summer profile for the Abu Dhabi coast, built from
fixed harmonics. It is a function of the clock time only: the same timestamp
always gives the same values. It is not a forecast and not an observation, and
every payload built from it is labelled synthetic.

The week contains the conditions an operator needs to rehearse:
    day 3   humid heat: night-time wet-bulb above the tower design point
    day 5   dry shamal wind: very dry air and the highest evaporation per kW
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from functools import lru_cache

import numpy as np

from ..physics import psychro as ps
from ..schemas import WeatherHour

LABEL = "Synthetic design week (Abu Dhabi peak-summer profile)"
NOTICE = (
    "Demo mode: synthetic, deterministic weather profile. It is not a forecast and not an "
    "observation."
)

_EPOCH = datetime(2000, 1, 1, tzinfo=timezone.utc)
_T_OFFSET = np.array([0.0, 0.6, 1.6, 1.0, -0.8, 0.2, 0.9])  # K, by day of the design week
_TD_OFFSET = np.array([0.0, 0.8, 2.2, 1.6, -5.0, -1.0, 2.6])  # K
_WIND_FACTOR = np.array([1.0, 1.0, 0.8, 0.9, 1.9, 1.2, 1.0])
_CLEARNESS = np.array([1.0, 0.97, 0.92, 0.95, 0.85, 0.98, 0.93])


def _blend(table: np.ndarray, day_position: np.ndarray) -> np.ndarray:
    """Interpolate a per-day value between day centres so it is continuous."""
    x = day_position - 0.5
    d0 = np.floor(x).astype(int)
    s = x - d0
    return (1.0 - s) * table[d0 % 7] + s * table[(d0 + 1) % 7]


def _bump(hour: np.ndarray, centre: float, width: float) -> np.ndarray:
    d = (hour - centre + 12.0) % 24.0 - 12.0
    return np.exp(-0.5 * (d / width) ** 2)


@lru_cache(maxsize=64)
def _series(start: datetime, hours: int, utc_offset_hours: float) -> tuple[WeatherHour, ...]:
    times = [start + timedelta(hours=k) for k in range(hours)]
    local_seconds = (start - _EPOCH).total_seconds() + utc_offset_hours * 3600.0
    day_position = (local_seconds + 3600.0 * np.arange(hours)) / 86_400.0
    hour = (day_position % 1.0) * 24.0
    day = np.floor(day_position).astype(int) % 7

    angle = 2.0 * np.pi * (hour - 14.5) / 24.0
    t_db = 37.5 + 6.0 * np.cos(angle) + 0.8 * np.cos(2.0 * angle) + _blend(_T_OFFSET, day_position)

    dew = 22.5 - 4.5 * np.cos(2.0 * np.pi * (hour - 13.5) / 24.0)
    dew = dew + 1.5 * _bump(hour, 20.5, 3.0) + _blend(_TD_OFFSET, day_position)
    dew = np.minimum(dew, t_db - 0.6)

    pressure_hpa = 1000.5 + 1.2 * np.cos(2.0 * np.pi * (hour - 10.0) / 12.0)
    p = pressure_hpa * 100.0
    w = ps.humidity_ratio_from_dew_point(dew, p)
    rh = ps.relative_humidity(t_db, w, p)
    t_wb = ps.wet_bulb(t_db, w, p)

    sea_breeze = np.where((hour >= 10.0) & (hour <= 19.0), np.maximum(np.sin(np.pi * (hour - 10.0) / 9.0), 0.0), 0.0)
    wind = (3.2 + 2.2 * sea_breeze) * _blend(_WIND_FACTOR, day_position) + 0.4 * np.sin(1.7 * hour + day)

    sun = np.where((hour > 5.9) & (hour < 18.85), np.sin(np.pi * (hour - 5.9) / 12.95), 0.0)
    ghi = 960.0 * _blend(_CLEARNESS, day_position) * np.maximum(sun, 0.0) ** 1.15

    shower = 1.2 * _bump(hour, 16.5, 0.7)  # one brief convective shower in the week
    precip = np.where((day == 6) & (shower > 0.05), shower, 0.0)

    evaporation = 0.02 + 0.00055 * ghi * (1.0 - rh) + 0.004 * wind * (1.0 - rh)

    return tuple(
        WeatherHour(
            time=times[k],
            t_2m_c=round(float(t_db[k]), 2),
            wet_bulb_c=round(float(t_wb[k]), 2),
            rh_pct=round(float(rh[k]) * 100.0, 1),
            dew_point_c=round(float(dew[k]), 2),
            wind_ms=round(max(float(wind[k]), 0.3), 2),
            global_rad_w_m2=round(float(ghi[k]), 1),
            precip_mm=round(float(precip[k]), 2),
            evaporation_mm=round(float(evaporation[k]), 3),
            pressure_hpa=round(float(pressure_hpa[k]), 1),
        )
        for k in range(hours)
    )


def demo_series(start: datetime, hours: int, utc_offset_hours: float = 4.0) -> list[WeatherHour]:
    """Hourly synthetic records from `start`. Returns fresh copies."""
    rows = _series(start.astimezone(timezone.utc), int(hours), float(utc_offset_hours))
    return [r.model_copy() for r in rows]


def demo_hour(time: datetime, utc_offset_hours: float = 4.0) -> WeatherHour:
    return demo_series(time, 1, utc_offset_hours)[0]
