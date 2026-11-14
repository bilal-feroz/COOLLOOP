"""System alerts. Every alert is derived from a verified quantity: the weather
bundle, the simulated operating point or the forecast projection."""

from __future__ import annotations

from .facility import Facility, OperatingConfig
from .schemas import Alert, PointResult, Projection, WeatherBundle

_ORDER = {"critical": 0, "warning": 1, "info": 2}


def build_alerts(
    fac: Facility,
    cfg: OperatingConfig,
    weather: WeatherBundle,
    now: PointResult | None,
    projection: Projection | None,
) -> list[Alert]:
    alerts: list[Alert] = []

    # --- data source ----------------------------------------------------------
    if weather.status in ("unavailable", "not_configured"):
        alerts.append(
            Alert(
                id="weather-unavailable", severity="critical", title="No weather data",
                detail=(weather.error.message if weather.error else weather.notice)
                or "The simulation cannot follow the forecast until weather data is available.",
                source="Weather service",
            )  # fmt: skip
        )
    elif weather.status == "cached":
        alerts.append(
            Alert(
                id="weather-cached", severity="warning", title="Weather update failed, using cached forecast",
                detail=(
                    f"{weather.error.message if weather.error else 'Live update failed.'} "
                    f"Last successful update {weather.last_success_at:%d %b %H:%M} UTC."
                ),
                source="Weather service", time=weather.last_success_at,
            )  # fmt: skip
        )
    elif weather.status == "demo":
        alerts.append(
            Alert(
                id="weather-demo", severity="info", title="Demo mode: synthetic weather",
                detail="Weather is a deterministic synthetic profile, not a forecast or an observation.",
                source="Weather service",
            )  # fmt: skip
        )
    if weather.wet_bulb_source == "derived":
        alerts.append(
            Alert(
                id="wet-bulb-derived", severity="info", title="Wet-bulb is derived",
                detail=(
                    "The weather account does not provide wet-bulb temperature; it is computed "
                    "from air temperature and humidity (ASHRAE psychrometrics)."
                ),
                source="Weather service",
            )  # fmt: skip
        )
    quota = weather.quota
    if quota and quota.limit_today and quota.used_today is not None:
        if quota.used_today >= 0.9 * quota.limit_today:
            alerts.append(
                Alert(
                    id="quota", severity="warning", title="Weather API quota nearly used",
                    detail=f"{quota.used_today} of {quota.limit_today} Meteomatics queries used today.",
                    source="Meteomatics user statistics",
                )  # fmt: skip
            )

    # --- current operating point --------------------------------------------------
    if now is not None:
        for c in now.constraints:
            if c.status == "violated":
                alerts.append(
                    Alert(
                        id=f"now-{c.id}", severity="critical", title=f"{c.label} out of limits",
                        detail=f"{c.value:g} {c.unit} against a limit of {c.limit:g} {c.unit}. {c.detail}.",
                        source="Simulated operating point", time=now.conditions.time,
                    )  # fmt: skip
                )
        if cfg.tower_cells_online < fac.tower_cells_duty and now.thermal.wet_load_kw > 1:
            alerts.append(
                Alert(
                    id="cells-out", severity="warning", title="Tower cells out of service",
                    detail=(
                        f"{cfg.tower_cells_online} of {fac.tower_cell_count} cells in service; "
                        f"{fac.tower_cells_duty} are needed for duty at design conditions."
                    ),
                    source="Operating configuration",
                )  # fmt: skip
            )

    # --- forecast projection --------------------------------------------------------
    if projection is not None:
        day = projection.day
        if day.infeasible_hours:
            alerts.append(
                Alert(
                    id="forecast-infeasible", severity="critical",
                    title="Forecast hours break equipment limits",
                    detail=(
                        f"{day.infeasible_hours} of the next {day.hours} hours violate a limit "
                        "with the current configuration."
                    ),
                    source="Forecast projection", time=day.max_stress_time,
                )  # fmt: skip
            )
        utilisation = day.allocation_utilisation
        if utilisation is not None and utilisation > 1.0:
            alerts.append(
                Alert(
                    id="water-over", severity="critical", title="Water demand exceeds the allocation",
                    detail=(
                        f"Projected makeup for the next {day.hours} h is {day.makeup_m3:.0f} m³ against "
                        f"an allocation of {day.allocation_m3:.0f} m³."
                    ),
                    source="Forecast projection", time=day.peak_makeup_time,
                )  # fmt: skip
            )
        elif utilisation is not None and utilisation > 0.9:
            alerts.append(
                Alert(
                    id="water-high", severity="warning", title="Water demand close to the allocation",
                    detail=(
                        f"Projected makeup for the next {day.hours} h is {day.makeup_m3:.0f} m³, "
                        f"{utilisation * 100:.0f} % of the {day.allocation_m3:.0f} m³ allocation."
                    ),
                    source="Forecast projection", time=day.peak_makeup_time,
                )  # fmt: skip
            )
        reserve = fac.tank_reserve_fraction * 100.0
        horizon = projection.horizon
        if horizon.min_tank_level_pct < reserve:
            alerts.append(
                Alert(
                    id="tank-reserve", severity="critical", title="Tank falls below its reserve",
                    detail=(
                        f"Stored water is projected to fall to {horizon.min_tank_level_pct:.0f} % "
                        f"(reserve {reserve:.0f} %) within the forecast."
                    ),
                    source="Forecast projection",
                )  # fmt: skip
            )
        elif horizon.min_tank_level_pct < reserve + 15.0:
            alerts.append(
                Alert(
                    id="tank-low", severity="warning", title="Tank drawdown forecast",
                    detail=(
                        f"Stored water is projected to fall to {horizon.min_tank_level_pct:.0f} % "
                        f"within the forecast (reserve {reserve:.0f} %)."
                    ),
                    source="Forecast projection",
                )  # fmt: skip
            )
        if horizon.max_wet_bulb_c >= fac.tower_design_wet_bulb_c - 0.5:
            alerts.append(
                Alert(
                    id="wet-bulb-design", severity="warning", title="Wet-bulb near the tower design point",
                    detail=(
                        f"Wet-bulb is forecast to reach {horizon.max_wet_bulb_c:.1f} °C "
                        f"(tower design {fac.tower_design_wet_bulb_c:.0f} °C)."
                    ),
                    source="Weather forecast", time=horizon.max_wet_bulb_time,
                )  # fmt: skip
            )
        for period in projection.periods:
            if period.level in ("high", "critical") and period.kind in ("thermal", "dry"):
                alerts.append(
                    Alert(
                        id=f"period-{period.kind}-{period.start:%d%H}",
                        severity="critical" if period.level == "critical" else "warning",
                        title="Thermal headroom is short" if period.kind == "thermal" else "Dry plant near capacity",
                        detail=f"{period.detail} Lasts {period.hours} h.",
                        source="Forecast projection", time=period.start,
                    )  # fmt: skip
                )

    seen: set[str] = set()
    unique = [a for a in alerts if not (a.id in seen or seen.add(a.id))]
    unique.sort(key=lambda a: _ORDER[a.severity])
    return unique
