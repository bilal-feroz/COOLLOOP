"""Deterministic operations briefing.

Three analyst roles, each a set of plain rules over verified inputs:

    Climate Analyst     weather bundle + forecast projection
    Thermal Analyst     simulated operating point + projection (+ last 24 h)
    Operations Planner  optimisation result

Every sentence is assembled from numbers that already exist in those inputs,
and each finding lists the values it rests on. No language model is involved,
so the briefing is always available and never invents a figure.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, Field

from ..facility import Facility, Location, OperatingConfig
from ..schemas import (
    AuditEntry,
    Constraint,
    Deltas,
    Metric,
    OptimizationResult,
    ParameterChange,
    PointResult,
    Projection,
    Scenario,
    WeatherBundle,
    WindowSummary,
)

Severity = Literal["info", "watch", "warning", "critical"]


class Finding(BaseModel):
    title: str
    detail: str
    severity: Severity = "info"
    evidence: list[Metric] = Field(default_factory=list)


class AnalystSection(BaseModel):
    role: Literal["climate", "thermal", "planner"]
    name: str
    remit: str
    headline: str
    findings: list[Finding]


class Basis(BaseModel):
    weather_status: str
    weather_source: str
    weather_synthetic: bool
    weather_fetched_at: datetime | None
    forecast_from: datetime | None
    forecast_to: datetime | None
    window_hours: int
    config_source: str


class Recommendation(BaseModel):
    scenario_key: str
    label: str
    actionable: bool  # False when the current configuration is the recommendation
    feasible: bool
    reason: str
    window_hours: int
    config: OperatingConfig
    changes: list[ParameterChange]
    rationale: list[str]
    deltas: Deltas | None
    summary: WindowSummary
    baseline_summary: WindowSummary
    constraints: list[Constraint]
    approval_note: str = (
        "Applying this changes the simulated facility only, and only after an operator approves it."
    )


class Briefing(BaseModel):
    simulated: bool = True
    generated_at: datetime
    basis: Basis
    sections: list[AnalystSection]
    recommendation: Recommendation | None
    audit: list[AuditEntry]


def _m(label: str, value: float | None, unit: str = "", digits: int = 1) -> Metric:
    return Metric(label=label, value=value, unit=unit, digits=digits)


def _local(t: datetime | None, location: Location) -> str:
    if t is None:
        return "n/a"
    return (t.astimezone(timezone.utc) + timedelta(hours=location.utc_offset_hours)).strftime("%a %H:%M")


def _span(start: datetime, end: datetime, location: Location) -> str:
    return f"{_local(start, location)} to {_local(end, location)}"


# --- Climate Analyst -----------------------------------------------------------------
def climate_section(fac: Facility, weather: WeatherBundle, projection: Projection | None) -> AnalystSection:
    loc = weather.location
    findings: list[Finding] = []
    now = weather.current
    if now is None or projection is None:
        return AnalystSection(
            role="climate", name="Climate Analyst",
            remit="Reads the weather forecast and flags environmental risk to cooling.",
            headline="No weather data is available, so no climate assessment can be made.",
            findings=[
                Finding(
                    title="Weather feed unavailable",
                    detail=(weather.error.message if weather.error else weather.notice) or "No data.",
                    severity="critical",
                )
            ],
        )  # fmt: skip

    design_wb = fac.tower_design_wet_bulb_c
    horizon = projection.horizon
    gap = design_wb - (now.wet_bulb_c or 0.0)
    findings.append(
        Finding(
            title="Conditions now",
            detail=(
                f"Dry-bulb {now.t_2m_c:.1f} °C, wet-bulb {now.wet_bulb_c:.1f} °C, humidity "
                f"{now.rh_pct:.0f} %. Wet-bulb is {abs(gap):.1f} K "
                f"{'below' if gap >= 0 else 'above'} the {design_wb:.0f} °C tower design point."
            ),
            severity="info" if gap > 2 else "watch" if gap > 0 else "warning",
            evidence=[
                _m("Dry-bulb", now.t_2m_c, "°C"), _m("Wet-bulb", now.wet_bulb_c, "°C"),
                _m("Relative humidity", now.rh_pct, "%", 0), _m("Tower design wet-bulb", design_wb, "°C", 0),
            ],
        )  # fmt: skip
    )

    peak_gap = design_wb - horizon.max_wet_bulb_c
    findings.append(
        Finding(
            title="Peak wet-bulb in the forecast",
            detail=(
                f"Wet-bulb peaks at {horizon.max_wet_bulb_c:.1f} °C on "
                f"{_local(horizon.max_wet_bulb_time, loc)}, "
                + (
                    f"{peak_gap:.1f} K under the tower design point. Tower approach has room."
                    if peak_gap > 1.0 else
                    f"within {max(peak_gap, 0):.1f} K of the tower design point. Condenser water will "
                    "run warm and chiller efficiency will fall in those hours."
                    if peak_gap >= 0 else
                    f"{-peak_gap:.1f} K above the tower design point. Expect the highest condenser "
                    "water temperatures of the period then."
                )
            ),
            severity="info" if peak_gap > 1.0 else "warning" if peak_gap >= 0 else "critical",
            evidence=[
                _m("Peak wet-bulb", horizon.max_wet_bulb_c, "°C"),
                _m("Margin to design", peak_gap, "K"),
                _m("Peak condenser water supply", horizon.max_cws_c, "°C"),
            ],
        )  # fmt: skip
    )

    hottest = max(range(len(projection.t_db_c)), key=projection.t_db_c.__getitem__)
    t_hot = projection.t_db_c[hottest]
    derate = min(max(1.0 - fac.ac_derate_per_k * (t_hot - fac.ac_rating_ambient_c), 0.55), 1.10)
    dry_cap = fac.dry_capacity_rated_kw * derate
    findings.append(
        Finding(
            title="Peak dry-bulb and the dry plant",
            detail=(
                f"Dry-bulb peaks at {t_hot:.1f} °C on {_local(projection.times[hottest], loc)}. "
                f"At that temperature the air-cooled plant can carry {dry_cap:,.0f} kW "
                f"({derate * 100:.0f} % of its rating), which caps how much load can move off the towers."
            ),
            severity="info" if derate >= 0.95 else "watch",
            evidence=[
                _m("Peak dry-bulb", t_hot, "°C"), _m("Dry capacity at peak", dry_cap, "kW", 0),
                _m("Rated dry capacity", fac.dry_capacity_rated_kw, "kW", 0),
            ],
        )  # fmt: skip
    )

    driest = min(range(len(projection.rh_pct)), key=projection.rh_pct.__getitem__)
    latent = projection.latent_fraction[driest]
    if latent is not None:
        findings.append(
            Finding(
                title="Driest air and evaporation",
                detail=(
                    f"Humidity bottoms out at {projection.rh_pct[driest]:.0f} % on "
                    f"{_local(projection.times[driest], loc)} with dry-bulb {projection.t_db_c[driest]:.1f} °C. "
                    f"The towers then evaporate {latent:.2f} kW of latent heat per kW rejected"
                    + (
                        ": the hot, dry air is itself cooled in the tower, which costs extra water."
                        if latent > 1.0 else "."
                    )
                ),
                severity="watch" if latent > 1.15 else "info",
                evidence=[
                    _m("Lowest humidity", projection.rh_pct[driest], "%", 0),
                    _m("Latent fraction then", latent, "", 2),
                    _m("Makeup then", projection.makeup_m3_h[driest], "m³/h", 1),
                ],
            )  # fmt: skip
        )

    rain = sum((h.precip_mm or 0.0) for h in weather.hourly[: len(projection.times)])
    if rain > 0.05:
        findings.append(
            Finding(
                title="Precipitation",
                detail=(
                    f"{rain:.1f} mm of rain is forecast in the period. It is not credited as makeup water."
                ),
                evidence=[_m("Forecast precipitation", rain, "mm", 1)],
            )
        )

    missing = [p.label.lower() for p in weather.parameters if p.source == "unavailable"]
    derived = [p.label.lower() for p in weather.parameters if p.source == "derived"]
    quality = {
        "live": "Live Meteomatics forecast.",
        "cached": "Cached Meteomatics forecast: the last live update failed.",
        "demo": "Synthetic demo profile, not a forecast.",
    }.get(weather.status, weather.status)
    if derived:
        quality += f" Derived here: {', '.join(derived)}."
    if missing:
        quality += f" Not available from the account: {', '.join(missing)}."
    findings.append(
        Finding(
            title="Data basis",
            detail=quality,
            severity="info" if weather.status == "live" else "watch",
        )
    )

    worst = max(findings, key=lambda f: ["info", "watch", "warning", "critical"].index(f.severity))
    headline = {
        "info": f"No weather-driven cooling risk in the next {horizon.hours} hours.",
        "watch": f"Weather is workable; watch: {worst.title.lower()}.",
        "warning": f"Weather will tighten cooling margins: {worst.title.lower()}.",
        "critical": f"Weather exceeds a design condition: {worst.title.lower()}.",
    }[worst.severity]
    return AnalystSection(
        role="climate", name="Climate Analyst",
        remit="Reads the weather forecast and flags environmental risk to cooling.",
        headline=headline, findings=findings,
    )  # fmt: skip


# --- Thermal Analyst -----------------------------------------------------------------
def thermal_section(
    fac: Facility,
    location: Location,
    now: PointResult | None,
    projection: Projection | None,
    previous_day: WindowSummary | None,
) -> AnalystSection:
    remit = "Explains the simulated water and energy use and what drives them."
    if now is None or projection is None:
        return AnalystSection(
            role="thermal", name="Thermal Analyst", remit=remit,
            headline="No simulation is available without weather data.", findings=[],
        )  # fmt: skip
    w, t, e = now.water, now.thermal, now.energy
    day = projection.day
    findings: list[Finding] = []

    if w.makeup_m3_h > 1e-6:
        blowdown_share = w.blowdown_m3_h / w.makeup_m3_h * 100.0
        findings.append(
            Finding(
                title="Water balance now",
                detail=(
                    f"Makeup {w.makeup_m3_h:.1f} m³/h = evaporation {w.evaporation_m3_h:.1f} + blowdown "
                    f"{w.blowdown_m3_h:.1f} + drift {w.drift_m3_h:.2f} m³/h. Blowdown is "
                    f"{blowdown_share:.0f} % of makeup at {w.cycles_of_concentration:.1f} cycles of "
                    f"concentration. Water use effectiveness is {w.wue_l_kwh:.2f} L per kWh of IT energy."
                ),
                evidence=[
                    _m("Makeup", w.makeup_m3_h, "m³/h", 2), _m("Evaporation", w.evaporation_m3_h, "m³/h", 2),
                    _m("Blowdown", w.blowdown_m3_h, "m³/h", 2), _m("Drift", w.drift_m3_h, "m³/h", 3),
                    _m("Cycles of concentration", w.cycles_of_concentration, "", 1),
                    _m("WUE", w.wue_l_kwh, "L/kWh", 2),
                ],
            )  # fmt: skip
        )
    else:
        findings.append(
            Finding(
                title="Water balance now",
                detail="The wet plant is off, so there is no evaporation, blowdown or drift.",
                evidence=[_m("Makeup", 0.0, "m³/h", 2)],
            )
        )

    mean = day.makeup_m3 / max(day.hours, 1)
    peak_i = max(range(min(24, len(projection.makeup_m3_h))), key=projection.makeup_m3_h.__getitem__)
    if mean > 0.01:
        swing = (day.peak_makeup_m3_h / mean - 1.0) * 100.0
        latent = projection.latent_fraction[peak_i]
        findings.append(
            Finding(
                title="What drives water demand",
                detail=(
                    f"Over the next {day.hours} h makeup totals {day.makeup_m3:.0f} m³ and peaks at "
                    f"{day.peak_makeup_m3_h:.1f} m³/h on {_local(day.peak_makeup_time, location)}, "
                    f"{swing:.0f} % above the mean. At the peak the air is {projection.t_db_c[peak_i]:.1f} °C "
                    f"with {projection.rh_pct[peak_i]:.0f} % humidity"
                    + (f" and the latent fraction is {latent:.2f}" if latent is not None else "")
                    + ". Heat load is steady, so the swing comes from how dry the air is, not from the IT load."
                ),
                severity="watch" if swing > 25 else "info",
                evidence=[
                    _m("Makeup, next 24 h", day.makeup_m3, "m³", 0),
                    _m("Peak makeup", day.peak_makeup_m3_h, "m³/h", 1),
                    _m("Mean makeup", mean, "m³/h", 1),
                    _m("Allocation used", (day.allocation_utilisation or 0) * 100, "%", 0),
                ],
            )  # fmt: skip
        )

    windows = sorted((p for p in projection.periods if p.kind == "water"), key=lambda p: p.start)[:3]
    if windows:
        spans = "; ".join(f"{_span(p.start, p.end, location)}, peak {p.peak:.1f} m³/h" for p in windows)
        order = ["nominal", "elevated", "high", "critical"]
        rank = {"nominal": "info", "elevated": "watch", "high": "warning", "critical": "critical"}
        worst_level = max(windows, key=lambda p: order.index(p.level)).level
        plural = "s" if len(windows) > 1 else ""
        findings.append(
            Finding(
                title="Upcoming high-demand periods",
                detail=(
                    f"Makeup demand is highest in {len(windows)} period{plural} of the forecast: {spans}. "
                    "These are the hours to protect stored water."
                ),
                severity=rank[worst_level],
                evidence=[_m(f"Peak {k + 1}", p.peak, "m³/h", 1) for k, p in enumerate(windows)],
            )
        )

    if previous_day is not None and previous_day.makeup_m3 > 0.01 and previous_day.hours >= 12:
        scale = day.hours / previous_day.hours
        before = previous_day.makeup_m3 * scale
        change = (day.makeup_m3 / before - 1.0) * 100.0
        wue_change = day.avg_wue_l_kwh - previous_day.avg_wue_l_kwh
        unusual = abs(change) >= 8.0
        findings.append(
            Finding(
                title="Consumption against the previous day",
                detail=(
                    f"The next {day.hours} h need {day.makeup_m3:.0f} m³, {abs(change):.0f} % "
                    f"{'more' if change > 0 else 'less'} than the previous {previous_day.hours} h "
                    f"({before:.0f} m³ at the same configuration). "
                    + (
                        f"That is outside the normal day-to-day range. WUE moves from "
                        f"{previous_day.avg_wue_l_kwh:.2f} to {day.avg_wue_l_kwh:.2f} L/kWh, and peak "
                        f"wet-bulb from {previous_day.max_wet_bulb_c:.1f} to {day.max_wet_bulb_c:.1f} °C: "
                        "the weather, not the plant, explains the change."
                        if unusual else
                        "That is within the normal day-to-day range."
                    )
                ),
                severity="watch" if unusual else "info",
                evidence=[
                    _m("Next period", day.makeup_m3, "m³", 0), _m("Previous period", before, "m³", 0),
                    _m("Change", change, "%", 1), _m("WUE change", wue_change, "L/kWh", 2),
                ],
            )  # fmt: skip
        )

    chillers = e.wc_chiller_kw + e.ac_chiller_kw
    findings.append(
        Finding(
            title="Cooling energy now",
            detail=(
                f"Cooling draws {e.cooling_power_kw:,.0f} kW for a {t.cooling_load_kw:,.0f} kW load "
                f"(partial PUE {e.ppue:.3f}). Chillers take {chillers / e.cooling_power_kw * 100:.0f} %"
                + (f" at COP {t.wc_cop:.1f} with condenser water at {t.cws_c:.1f} °C" if t.wc_cop and t.cws_c else "")
                + f"; fans and pumps take the rest."
            ),
            evidence=[
                _m("Cooling power", e.cooling_power_kw, "kW", 0), _m("Partial PUE", e.ppue, "", 3),
                _m("Water-cooled COP", t.wc_cop, "", 2), _m("Air-cooled COP", t.ac_cop, "", 2),
                _m("Condenser water supply", t.cws_c, "°C", 1),
            ],
        )  # fmt: skip
    )

    tight = [c for c in now.constraints if c.status in ("warning", "violated")]
    cap = now.capacity
    findings.append(
        Finding(
            title="Thermal headroom",
            detail=(
                f"Cooling capacity is {cap.cooling_capacity_kw:,.0f} kW against a load of "
                f"{t.cooling_load_kw:,.0f} kW ({cap.utilisation * 100:.0f} % used). "
                + (
                    "Closest limits: " + "; ".join(
                        f"{c.label.lower()} {c.value:g} of {c.limit:g} {c.unit}".strip() for c in tight[:3]
                    ) + "."
                    if tight else "No constraint is inside its warning band."
                )
                + (
                    f" {day.infeasible_hours} of the next {day.hours} h break a limit."
                    if day.infeasible_hours else ""
                )
            ),
            severity=(
                "critical" if day.infeasible_hours or any(c.status == "violated" for c in tight)
                else "warning" if tight else "info"
            ),
            evidence=[
                _m("Cooling capacity", cap.cooling_capacity_kw, "kW", 0),
                _m("Capacity margin", cap.margin_kw, "kW", 0),
                _m("Lowest margin, next 24 h", day.min_capacity_margin_kw, "kW", 0),
                _m("Peak stress index", day.max_stress, "", 2),
            ],
        )  # fmt: skip
    )

    worst = max(findings, key=lambda f: ["info", "watch", "warning", "critical"].index(f.severity))
    headline = (
        f"Plant is using {w.makeup_m3_h:.1f} m³/h of water and {e.cooling_power_kw:,.0f} kW of cooling "
        f"power; {worst.title.lower()} needs attention."
        if worst.severity in ("warning", "critical") else
        f"Plant is using {w.makeup_m3_h:.1f} m³/h of water and {e.cooling_power_kw:,.0f} kW of cooling "
        "power, inside every limit."
    )
    return AnalystSection(role="thermal", name="Thermal Analyst", remit=remit, headline=headline, findings=findings)


# --- Operations Planner --------------------------------------------------------------
def _rationale(fac: Facility, change: ParameterChange, base: Scenario, chosen: Scenario) -> str:
    up = change.after > change.before
    arrow = f"{change.before:g} to {change.after:g} {change.unit}".strip()
    if change.key == "cycles_of_concentration":
        before = 1.0 / (change.before - 1.0) * 100.0
        after = 1.0 / (change.after - 1.0) * 100.0
        return (
            f"Cycles of concentration {arrow}: blowdown falls from {before:.0f} % to {after:.0f} % of "
            f"evaporation at no energy cost. {fac.coc_max:g} is the assumed chemistry limit."
        )
    if change.key == "chw_supply_c":
        return (
            f"Chilled water supply {arrow}: a {'warmer' if up else 'colder'} evaporator "
            f"{'raises' if up else 'lowers'} chiller COP. Server inlet stays inside its "
            f"{fac.server_inlet_limit_c:g} °C limit."
        )
    if change.key == "tower_fan_speed":
        cws = chosen.summary.max_cws_c
        return (
            f"Tower fan speed {arrow}: fan power follows the cube of speed, and less air through the "
            "towers evaporates less water in hot, dry air."
            + (f" Condenser water peaks at {cws:.1f} °C, under the {fac.cws_max_c:g} °C limit." if cws else "")
        )
    if change.key == "cw_pump_speed":
        return (
            f"Condenser pump speed {arrow}: pump power falls steeply with speed while each tower cell "
            f"stays above its minimum wetting flow."
        )
    if change.key == "wet_fraction":
        dry_share = 100.0 - change.after
        return (
            f"Evaporative share {arrow}: {dry_share:.0f} % of the cooling load moves to the air-cooled "
            "plant, which uses no water but more compressor energy."
            if not up else
            f"Evaporative share {arrow}: more load on the towers, which use water but less energy."
        )
    return f"{change.label} {arrow}."


def planner_section(
    fac: Facility, location: Location, result: OptimizationResult | None
) -> tuple[AnalystSection, Recommendation | None]:
    remit = "Turns the optimisation result into an action for the operator to approve."
    if result is None:
        return (
            AnalystSection(
                role="planner", name="Operations Planner", remit=remit,
                headline="No optimisation can run without weather data.", findings=[],
            ),  # fmt: skip
            None,
        )
    by_key = {s.key: s for s in result.scenarios}
    base, water, balanced = by_key["baseline"], by_key["water_saving"], by_key["balanced"]
    chosen = by_key[result.recommended]
    actionable = chosen.key != "baseline" and chosen.feasible
    findings: list[Finding] = []

    if actionable and chosen.deltas:
        d = chosen.deltas
        findings.append(
            Finding(
                title=f"Recommended: {chosen.label.lower()} configuration",
                detail=(
                    f"{result.recommendation_reason} Over the next {result.window_hours} h it uses "
                    f"{chosen.summary.makeup_m3:.0f} m³ of makeup ({d.makeup_pct:+.0f} %) and "
                    f"{chosen.summary.cooling_energy_kwh:,.0f} kWh of cooling energy ({d.energy_pct:+.1f} %) "
                    "against the current configuration."
                ),
                severity="info",
                evidence=[
                    _m("Makeup change", d.makeup_m3, "m³", 0), _m("Makeup change", d.makeup_pct, "%", 1),
                    _m("Energy change", d.energy_kwh, "kWh", 0), _m("Energy change", d.energy_pct, "%", 1),
                    _m("Objective value", chosen.objective.value if chosen.objective else None, "", 3),
                ],
            )  # fmt: skip
        )
        if d.makeup_m3 < -0.5 and d.energy_kwh > 0.5:
            rate = d.energy_kwh / -d.makeup_m3
            findings.append(
                Finding(
                    title="Water for energy trade",
                    detail=(
                        f"Each cubic metre of water saved costs {rate:.0f} kWh of extra cooling energy "
                        "in this window."
                    ),
                    evidence=[_m("Energy per m³ saved", rate, "kWh/m³", 0)],
                )
            )
        elif d.makeup_m3 < -0.5 and d.energy_kwh <= 0.5:
            findings.append(
                Finding(
                    title="No trade-off in this window",
                    detail="The recommended set points save water and cooling energy at the same time.",
                )
            )
    elif not base.feasible and not chosen.feasible:
        findings.append(
            Finding(
                title="No feasible configuration",
                detail=" ".join(water.infeasibility or balanced.infeasibility or base.infeasibility),
                severity="critical",
            )
        )
    else:
        findings.append(
            Finding(
                title="Keep the current configuration",
                detail=result.recommendation_reason,
            )
        )

    other = water if chosen.key != "water_saving" else balanced
    if other.feasible and other.deltas and other.key != chosen.key:
        d = other.deltas
        findings.append(
            Finding(
                title=f"Alternative: {other.label.lower()}",
                detail=(
                    f"{other.description} {d.makeup_pct:+.0f} % makeup and {d.energy_pct:+.1f} % cooling "
                    f"energy against the current configuration."
                ),
                evidence=[_m("Makeup change", d.makeup_pct, "%", 1), _m("Energy change", d.energy_pct, "%", 1)],
            )
        )
    elif not other.feasible and other.infeasibility:
        findings.append(
            Finding(
                title=f"{other.label} is not feasible",
                detail=" ".join(other.infeasibility),
                severity="watch",
            )
        )

    checked = [c for c in chosen.constraints if c.status != "n/a"]
    bad = [c for c in checked if c.status == "violated"]
    close = [c for c in checked if c.status == "warning"]
    findings.append(
        Finding(
            title="Constraints checked",
            detail=(
                f"{len(checked)} constraints checked in every hour of the window: "
                f"{len(checked) - len(bad) - len(close)} clear, {len(close)} inside their warning band, "
                f"{len(bad)} violated. {chosen.solver.message}"
            ),
            severity="critical" if bad else "watch" if close else "info",
            evidence=[
                _m("Solver evaluations", float(chosen.solver.evaluations), "", 0),
                _m("Solve time", chosen.solver.runtime_ms, "ms", 0),
            ],
        )  # fmt: skip
    )
    if not base.feasible:
        findings.append(
            Finding(
                title="Current configuration breaks a limit",
                detail=" ".join(base.infeasibility),
                severity="critical",
            )
        )

    recommendation = Recommendation(
        scenario_key=chosen.key, label=chosen.label, actionable=actionable, feasible=chosen.feasible,
        reason=result.recommendation_reason, window_hours=result.window_hours, config=chosen.config,
        changes=chosen.changes,
        rationale=[_rationale(fac, c, base, chosen) for c in chosen.changes] if actionable else [],
        deltas=chosen.deltas, summary=chosen.summary, baseline_summary=base.summary,
        constraints=chosen.constraints,
    )  # fmt: skip
    headline = (
        f"Apply the {chosen.label.lower()} configuration: {chosen.deltas.makeup_pct:+.0f} % water, "
        f"{chosen.deltas.energy_pct:+.1f} % cooling energy over the next {result.window_hours} h."
        if actionable and chosen.deltas else
        result.recommendation_reason
    )
    section = AnalystSection(
        role="planner", name="Operations Planner", remit=remit, headline=headline, findings=findings
    )
    return section, recommendation


def build_briefing(
    fac: Facility,
    weather: WeatherBundle,
    now: PointResult | None,
    projection: Projection | None,
    previous_day: WindowSummary | None,
    optimisation: OptimizationResult | None,
    config_source: str,
    audit: list[AuditEntry],
) -> Briefing:
    planner, recommendation = planner_section(fac, weather.location, optimisation)
    return Briefing(
        generated_at=datetime.now(timezone.utc),
        basis=Basis(
            weather_status=weather.status,
            weather_source=f"{weather.provider}" + (f" ({weather.model})" if weather.model else ""),
            weather_synthetic=weather.synthetic,
            weather_fetched_at=weather.fetched_at,
            forecast_from=projection.times[0] if projection else None,
            forecast_to=projection.horizon.end if projection else None,
            window_hours=optimisation.window_hours if optimisation else 0,
            config_source=config_source,
        ),
        sections=[
            climate_section(fac, weather, projection),
            thermal_section(fac, weather.location, now, projection, previous_day),
            planner,
        ],
        recommendation=recommendation,
        audit=audit,
    )
