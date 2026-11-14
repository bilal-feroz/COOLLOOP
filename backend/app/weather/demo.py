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

import math
from datetime import datetime, timedelta, timezone

import numpy as np

from ..physics import psychro as ps
from ..schemas import WeatherHour

LABEL = "Synthetic design week (Abu Dhabi peak-summer profile)"
NOTICE = (
    "Demo mode: synthetic, deterministic weather profile. It is not a forecast and not an "
    "observation."
)

_EPOCH = datetime(2000, 1, 1, tzinfo=timezone.utc)
_T_OFFSET = (0.0, 0.6, 1.6, 1.0, -0.8, 0.2, 0.9)  # K, by day of the design week
_TD_OFFSET = (0.0, 0.8, 2.2, 1.6, -5.0, -1.0, 2.6)  # K
_WIND_FACTOR = (1.0, 1.0, 0.8, 0.9, 1.9, 1.2, 1.0)
_CLEARNESS = (1.0, 0.97, 0.92, 0.95, 0.85, 0.98, 0.93)


def _blend(table: tuple[float, ...], day_position: float) -> float:
    """Interpolate a per-day value between day centres so it is continuous."""
    x = day_position - 0.5
    d0 = math.floor(x)
    s = x - d0
    return (1.0 - s) * table[d0 % 7] + s * table[(d0 + 1) % 7]


def _bump(hour: float, centre: float, width: float) -> float:
    d = (hour - centre + 12.0) % 24.0 - 12.0
    return math.exp(-0.5 * (d / width) ** 2)


def demo_hour(time: datetime, utc_offset_hours: float = 4.0) -> WeatherHour:
    local = time.astimezone(timezone.utc) + timedelta(hours=utc_offset_hours)
    day_position = (local - _EPOCH).total_seconds() / 86_400.0
    hour = (day_position % 1.0) * 24.0
    day = math.floor(day_position) % 7

    angle = 2.0 * math.pi * (hour - 14.5) / 24.0
    t_db = 37.5 + 6.0 * math.cos(angle) + 0.8 * math.cos(2.0 * angle) + _blend(_T_OFFSET, day_position)

    dew = 22.5 - 4.5 * math.cos(2.0 * math.pi * (hour - 13.5) / 24.0)
    dew += 1.5 * _bump(hour, 20.5, 3.0) + _blend(_TD_OFFSET, day_position)
    dew = min(dew, t_db - 0.6)

    pressure_hpa = 1000.5 + 1.2 * math.cos(2.0 * math.pi * (hour - 10.0) / 12.0)
    p = pressure_hpa * 100.0
    w = float(ps.humidity_ratio_from_dew_point(dew, p))
    rh = float(ps.relative_humidity(t_db, w, p))
    t_wb = float(ps.wet_bulb(np.array([t_db]), w, p)[0])

    sea_breeze = max(0.0, math.sin(math.pi * (hour - 10.0) / 9.0)) if 10.0 <= hour <= 19.0 else 0.0
    wind = (3.2 + 2.2 * sea_breeze) * _blend(_WIND_FACTOR, day_position)
    wind += 0.4 * math.sin(1.7 * hour + day)

    sun = math.sin(math.pi * (hour - 5.9) / 12.95) if 5.9 < hour < 18.85 else 0.0
    ghi = 960.0 * _blend(_CLEARNESS, day_position) * max(sun, 0.0) ** 1.15

    precip = 0.0
    if day == 6:  # one brief convective shower in the week
        precip = 1.2 * _bump(hour, 16.5, 0.7)
        precip = precip if precip > 0.05 else 0.0

    evaporation = 0.02 + 0.00055 * ghi * (1.0 - rh) + 0.004 * wind * (1.0 - rh)

    return WeatherHour(
        time=time.astimezone(timezone.utc),
        t_2m_c=round(t_db, 2),
        wet_bulb_c=round(t_wb, 2),
        rh_pct=round(rh * 100.0, 1),
        dew_point_c=round(dew, 2),
        wind_ms=round(max(wind, 0.3), 2),
        global_rad_w_m2=round(ghi, 1),
        precip_mm=round(precip, 2),
        evaporation_mm=round(evaporation, 3),
        pressure_hpa=round(pressure_hpa, 1),
    )


def demo_series(start: datetime, hours: int, utc_offset_hours: float = 4.0) -> list[WeatherHour]:
    return [demo_hour(start + timedelta(hours=k), utc_offset_hours) for k in range(hours)]
