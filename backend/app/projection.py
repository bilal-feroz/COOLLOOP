"""Project one operating configuration across the hourly weather forecast."""

from __future__ import annotations

from datetime import datetime, timedelta

import numpy as np

from .facility import AmbientOverride, Facility, Location, OperatingConfig
from .physics import psychro as ps
from .physics.plant import Ambient, Controls, PlantState, simulate, wet_cooling_capacity
from .report import (
    STRESS_LIMITS,
    constraint_specs,
    hard_feasible,
    stress_components,
    stress_index,
    stress_level,
)
from .schemas import Period, Projection, WeatherHour, WindowSummary


def _series(hours: list[WeatherHour], field: str) -> np.ndarray:
    return np.array(
        [np.nan if getattr(h, field) is None else getattr(h, field) for h in hours], dtype=float
    )


def _fill(values: np.ndarray, default: float | None = None) -> np.ndarray | None:
    """Linear interpolation over gaps; `default` (or None) if nothing is known."""
    known = np.isfinite(values)
    if not known.any():
        return None if default is None else np.full(values.shape, default)
    if known.all():
        return values
    idx = np.arange(values.size)
    return np.interp(idx, idx[known], values[known])


def ambient_from_hours(hours: list[WeatherHour], location: Location) -> Ambient:
    """Ambient arrays for the plant model from weather records.

    Wet-bulb is taken from the weather source when present; otherwise it is
    derived from relative humidity or dew point with ASHRAE psychrometrics.
    """
    if not hours:
        raise ValueError("No weather data to simulate against")
    t_db = _fill(_series(hours, "t_2m_c"))
    if t_db is None:
        raise ValueError("Weather data has no air temperature")
    pressure = _fill(_series(hours, "pressure_hpa") * 100.0, ps.standard_pressure(location.elevation_m))
    t_wb = _fill(_series(hours, "wet_bulb_c"))
    rh = None
    if t_wb is None:
        rh_pct = _fill(_series(hours, "rh_pct"))
        if rh_pct is not None:
            rh = rh_pct / 100.0
        else:
            dew = _fill(_series(hours, "dew_point_c"))
            if dew is None:
                raise ValueError("Weather data has no humidity information")
            rh = ps.relative_humidity(t_db, ps.humidity_ratio_from_dew_point(dew, pressure), pressure)
        t_wb = ps.wet_bulb(t_db, ps.humidity_ratio_from_rh(t_db, rh, pressure), pressure)
    return Ambient(
        t_db_c=t_db,
        t_wb_c=np.minimum(t_wb, t_db),
        pressure_pa=pressure,
        wind_ms=_fill(_series(hours, "wind_ms"), 3.0),
        ghi_w_m2=_fill(_series(hours, "global_rad_w_m2"), 0.0),
    )


def ambient_from_override(override: AmbientOverride, location: Location, n: int) -> Ambient:
    """A constant manual ambient, with its wet-bulb solved once up front."""
    p = ps.standard_pressure(location.elevation_m)
    t_db = np.full(n, override.t_db_c)
    w = ps.humidity_ratio_from_rh(t_db, override.rh_pct / 100.0, p)
    return Ambient(t_db_c=t_db, t_wb_c=ps.wet_bulb(t_db, w, p), pressure_pa=np.full(n, p))


def tank_levels(fac: Facility, cfg: OperatingConfig, makeup_m3_h: np.ndarray, start: float) -> np.ndarray:
    """Tank fill fraction at the end of each hour."""
    supply = cfg.water_allocation_m3_day / 24.0
    volume = start * fac.tank_capacity_m3
    out = np.empty(makeup_m3_h.size)
    for k, demand in enumerate(makeup_m3_h):
        volume = min(max(volume + supply - float(demand), 0.0), fac.tank_capacity_m3)
        out[k] = volume / fac.tank_capacity_m3
    return out


def _when(times: list[datetime], idx: int | None) -> datetime | None:
    return times[idx] if idx is not None and times else None


def window_summary(
    cfg: OperatingConfig,
    st: PlantState,
    times: list[datetime],
    stress: np.ndarray,
    tank: np.ndarray,
    margin_kw: np.ndarray,
    feasible: np.ndarray,
    window: slice,
) -> WindowSummary:
    idx = np.arange(st.t_db_c.size)[window]
    n = idx.size
    makeup = st.makeup_m3_h[idx]
    power = st.cooling_power_kw[idx]
    it = st.it_kw[idx]
    wet = st.wet_on[idx]
    allocation = cfg.water_allocation_m3_day * n / 24.0
    cws_idx = idx[wet][np.argmax(st.t_cws_c[idx][wet])] if wet.any() else None
    return WindowSummary(
        hours=n,
        start=_when(times, int(idx[0])),
        end=times[int(idx[-1])] + timedelta(hours=1) if times else None,
        makeup_m3=round(float(makeup.sum()), 2),
        evaporation_m3=round(float(st.evaporation_m3_h[idx].sum()), 2),
        blowdown_m3=round(float(st.blowdown_m3_h[idx].sum()), 2),
        drift_m3=round(float(st.drift_m3_h[idx].sum()), 3),
        cooling_energy_kwh=round(float(power.sum()), 1),
        it_energy_kwh=round(float(it.sum()), 1),
        avg_wue_l_kwh=round(float(makeup.sum() * 1000.0 / it.sum()), 3),
        avg_ppue=round(float((it.sum() + power.sum()) / it.sum()), 4),
        peak_makeup_m3_h=round(float(makeup.max()), 3),
        peak_makeup_time=_when(times, int(idx[np.argmax(makeup)])),
        peak_power_kw=round(float(power.max()), 1),
        peak_power_time=_when(times, int(idx[np.argmax(power)])),
        max_cws_c=None if cws_idx is None else round(float(st.t_cws_c[cws_idx]), 2),
        max_cws_time=None if cws_idx is None else _when(times, int(cws_idx)),
        max_wet_bulb_c=round(float(st.t_wb_c[idx].max()), 2),
        max_wet_bulb_time=_when(times, int(idx[np.argmax(st.t_wb_c[idx])])),
        max_stress=round(float(stress[idx].max()), 3),
        max_stress_time=_when(times, int(idx[np.argmax(stress[idx])])),
        min_capacity_margin_kw=round(float(margin_kw[idx].min()), 0),
        allocation_m3=round(allocation, 1),
        allocation_utilisation=round(float(makeup.sum() / allocation), 3) if allocation > 0 else None,
        min_tank_level_pct=round(float(tank[idx].min() * 100.0), 1),
        infeasible_hours=int((~feasible[idx]).sum()),
    )


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Inclusive (start, end) index pairs of consecutive True values."""
    out, start = [], None
    for k, flag in enumerate(mask):
        if flag and start is None:
            start = k
        elif not flag and start is not None:
            out.append((start, k - 1))
            start = None
    if start is not None:
        out.append((start, mask.size - 1))
    return out


def find_periods(
    cfg: OperatingConfig,
    st: PlantState,
    times: list[datetime],
    components: dict,
    stress: np.ndarray,
) -> list[Period]:
    """Upcoming windows an operator should know about, from simulated values."""
    periods: list[Period] = []
    hour = timedelta(hours=1)

    makeup = st.makeup_m3_h
    mean, peak = float(makeup.mean()), float(makeup.max())
    if mean > 0.01 and peak / mean - 1.0 >= 0.05:
        water_stress = components["Water allocation"]
        for a, b in _runs(makeup >= mean + 0.5 * (peak - mean)):
            top = float(makeup[a : b + 1].max())
            periods.append(
                Period(
                    kind="water", start=times[a], end=times[b] + hour, hours=b - a + 1,
                    peak=round(top, 2), unit="m³/h",
                    level=stress_level(float(water_stress[a : b + 1].max())),
                    detail=(
                        f"Makeup demand peaks at {top:.1f} m³/h, "
                        f"{(top / mean - 1.0) * 100:.0f} % above the horizon mean."
                    ),
                )  # fmt: skip
            )

    thermal = components["Condenser water temperature"]
    for a, b in _runs(thermal >= STRESS_LIMITS[0]):
        hottest = float(st.t_cws_c[a : b + 1].max())
        periods.append(
            Period(
                kind="thermal", start=times[a], end=times[b] + hour, hours=b - a + 1,
                peak=round(hottest, 2), unit="°C",
                level=stress_level(float(thermal[a : b + 1].max())),
                detail=(
                    f"Condenser water supply reaches {hottest:.1f} °C with wet-bulb up to "
                    f"{float(st.t_wb_c[a : b + 1].max()):.1f} °C."
                ),
            )  # fmt: skip
        )

    dry = components["Dry plant loading"]
    for a, b in _runs(dry >= STRESS_LIMITS[1]):
        top = float(dry[a : b + 1].max())
        periods.append(
            Period(
                kind="dry", start=times[a], end=times[b] + hour, hours=b - a + 1,
                peak=round(top * 100.0, 1), unit="%", level=stress_level(top),
                detail=(
                    f"Dry plant loaded to {top * 100:.0f} % of its derated capacity with "
                    f"dry-bulb up to {float(st.t_db_c[a : b + 1].max()):.1f} °C."
                ),
            )  # fmt: skip
        )

    order = {"critical": 0, "high": 1, "elevated": 2, "nominal": 3}
    periods.sort(key=lambda p: (order[p.level], p.start))
    return periods


def project(
    fac: Facility,
    cfg: OperatingConfig,
    times: list[datetime],
    amb: Ambient,
    *,
    ambient_source: str = "forecast",
    tank_start: float | None = None,
) -> tuple[PlantState, Projection]:
    """Simulate every hour with constant set points and summarise the result."""
    st = simulate(fac, Controls.from_config(cfg), amb)
    n = st.t_db_c.size
    components = stress_components(fac, st, cfg.water_allocation_m3_day)
    stress, drivers = stress_index(components)
    specs = constraint_specs(fac, cfg.water_allocation_m3_day, st)
    feasible = hard_feasible(specs, st)
    tank = tank_levels(fac, cfg, st.makeup_m3_h, fac.tank_initial_fraction if tank_start is None else tank_start)
    wet_cap, _ = wet_cooling_capacity(fac, st)
    margin_kw = wet_cap + st.dry_capacity_kw - st.q_cool_kw
    wet = st.wet_on

    def opt(values: np.ndarray, digits: int = 2) -> list[float | None]:
        return [round(float(v), digits) if on else None for v, on in zip(values, wet)]

    def num(values: np.ndarray, digits: int = 2) -> list[float]:
        return [round(float(v), digits) for v in values]

    latent = np.where(wet, st.q_latent_kw / np.maximum(st.q_rej_wet_kw, 1e-9), 0.0)
    everything = slice(0, n)
    summary_args = (cfg, st, times, stress, tank, margin_kw, feasible)
    projection = Projection(
        ambient_source=ambient_source,
        times=times,
        t_db_c=num(st.t_db_c),
        t_wb_c=num(st.t_wb_c),
        rh_pct=num(st.rh * 100.0, 1),
        cooling_load_kw=num(st.q_cool_kw, 0),
        heat_rejection_kw=num(st.heat_rejection_kw, 0),
        makeup_m3_h=num(st.makeup_m3_h, 3),
        evaporation_m3_h=num(st.evaporation_m3_h, 3),
        blowdown_m3_h=num(st.blowdown_m3_h, 3),
        drift_m3_h=num(st.drift_m3_h, 4),
        cooling_power_kw=num(st.cooling_power_kw, 1),
        cws_c=opt(st.t_cws_c),
        approach_k=opt(st.approach_k),
        latent_fraction=opt(latent, 3),
        wc_cop=opt(st.wc_cop),
        wue_l_kwh=num(st.wue_l_kwh, 3),
        ppue=num(st.ppue, 4),
        capacity_margin_kw=num(margin_kw, 0),
        tank_level_pct=num(tank * 100.0, 1),
        stress=num(stress, 3),
        stress_level=[stress_level(float(s)) for s in stress],
        stress_driver=drivers,
        feasible=[bool(f) for f in feasible],
        day=window_summary(*summary_args, slice(0, min(24, n))),
        horizon=window_summary(*summary_args, everything),
        periods=find_periods(cfg, st, times, components, stress),
    )
    return st, projection
