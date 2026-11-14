"""Deterministic set-point optimisation.

Problem
    minimise   w_water * M(x) / M_base  +  w_energy * E(x) / E_base
    over       x = (evaporative share, tower fan speed, condenser pump speed,
                    cycles of concentration, chilled-water supply set point)
    subject to equipment limits in every hour of the forecast window and the
               water allocation for the window.

    M is makeup water [m3] and E is cooling energy [kWh] summed over the window;
    both are normalised by the baseline configuration so the weights compare
    like with like.

Method
    SciPy SLSQP on the physics model, started from several fixed points so the
    result does not depend on chance. The solver first keeps an operating
    margin from every limit (the same band the UI shows as a warning); only if
    that is impossible does it fall back to the bare limits. The all-dry mode
    (towers off) is a discrete alternative and is checked explicitly.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np
from scipy.optimize import minimize

from .facility import PARAMETER_META, Facility, OperatingConfig
from .physics.plant import Ambient, Controls, PlantState, simulate
from .projection import project
from .report import constraint_specs, hard_feasible, scaled_margins, worst_constraints
from .schemas import (
    Constraint,
    Deltas,
    Objective,
    ObjectiveValue,
    OptimizationResult,
    ParameterChange,
    Scenario,
    SolverInfo,
    TradeoffPoint,
    WindowSummary,
)

VARIABLES = ("wet_fraction", "tower_fan_speed", "cw_pump_speed", "cycles_of_concentration", "chw_supply_c")
HYBRID_MIN_WET_FRACTION = 0.10  # below this the wet plant is switched off instead
WATER_MARGIN = 0.05  # share of the allocation kept in hand as an operating margin
_ROUNDING = np.array([0.01, 0.01, 0.01, 0.1, 0.1])
_SEARCH_TIER = 1.15  # search slightly inside the margin so rounding stays within it
_METHOD = "SLSQP (SciPy), 3 fixed starts"


@dataclass
class Window:
    times: list[datetime]
    ambient: Ambient
    source: str  # "forecast" or "manual"

    @property
    def hours(self) -> int:
        return len(self.times)


def _bounds(fac: Facility) -> tuple[np.ndarray, np.ndarray]:
    lo = np.array([HYBRID_MIN_WET_FRACTION, fac.tower_fan_speed_min, fac.cw_pump_speed_min, fac.coc_min, fac.chw_supply_min_c])
    hi = np.array([1.0, 1.0, 1.0, fac.coc_max, fac.chw_supply_max_c])
    return lo, hi


def _vector(cfg: OperatingConfig) -> np.ndarray:
    return np.array([getattr(cfg, name) for name in VARIABLES], dtype=float)


def _config(base: OperatingConfig, x: np.ndarray) -> OperatingConfig:
    return base.model_copy(update=dict(zip(VARIABLES, (float(v) for v in x))))


def _controls(base: OperatingConfig, x: np.ndarray) -> Controls:
    return Controls(
        it_load_kw=base.it_load_kw, chw_supply_c=x[4], tower_fan_speed=x[1],
        cw_pump_speed=x[2], cycles_of_concentration=x[3], wet_fraction=x[0],
        tower_cells_online=base.tower_cells_online,
    )  # fmt: skip


def _totals(st: PlantState) -> tuple[float, float]:
    """(makeup m3, cooling energy kWh) for hourly steps."""
    return float(st.makeup_m3_h.sum()), float(st.cooling_power_kw.sum())


def constraint_vector(
    fac: Facility, base: OperatingConfig, st: PlantState, tier: float, water: bool = True
) -> np.ndarray:
    """All constraints as one vector, >= 0 when satisfied (see `scaled_margins`).
    `water=False` leaves the water allocation out (equipment limits only)."""
    specs = constraint_specs(fac, base.water_allocation_m3_day, st)
    margins = scaled_margins(specs, tier)
    if not water:
        return margins
    allocation = base.water_allocation_m3_day * st.t_db_c.size / 24.0
    spare = allocation * (1.0 - WATER_MARGIN * tier) - float(st.makeup_m3_h.sum())
    return np.append(margins, spare / max(allocation, 1.0))


class _Problem:
    """Objective and constraints sharing cached simulations."""

    def __init__(self, fac, base, window: Window, objective: Objective, reference, tier: float, water: bool = True):
        self.fac, self.base, self.window, self.objective, self.tier = fac, base, window, objective, tier
        self.water = water
        self.m_ref = max(reference[0], 1e-3)
        self.e_ref = max(reference[1], 1e-3)
        self.lo, self.hi = _bounds(fac)
        self.evaluations = 0
        self._cache: dict[bytes, tuple[float, np.ndarray]] = {}
        self._guess: np.ndarray | None = None

    def x(self, z: np.ndarray) -> np.ndarray:
        return self.lo + np.clip(z, 0.0, 1.0) * (self.hi - self.lo)

    def z(self, x: np.ndarray) -> np.ndarray:
        return np.clip((x - self.lo) / (self.hi - self.lo), 0.0, 1.0)

    def _evaluate(self, z: np.ndarray) -> tuple[float, np.ndarray]:
        key = z.tobytes()
        hit = self._cache.get(key)
        if hit is None:
            st = simulate(self.fac, _controls(self.base, self.x(z)), self.window.ambient, guess=self._guess)
            self._guess = st.t_cwr_c
            self.evaluations += 1
            makeup, energy = _totals(st)
            cost = self.objective.w_water * makeup / self.m_ref + self.objective.w_energy * energy / self.e_ref
            hit = (cost, constraint_vector(self.fac, self.base, st, self.tier, self.water))
            if len(self._cache) > 512:
                self._cache.clear()
            self._cache[key] = hit
        return hit

    def cost(self, z):
        return self._evaluate(z)[0]

    def constraints(self, z):
        return self._evaluate(z)[1]

    def objective_value(self, makeup: float, energy: float) -> ObjectiveValue:
        o = self.objective
        water_term, energy_term = makeup / self.m_ref, energy / self.e_ref
        return ObjectiveValue(
            value=round(o.w_water * water_term + o.w_energy * energy_term, 5),
            w_water=o.w_water, w_energy=o.w_energy,
            water_term=round(water_term, 5), energy_term=round(energy_term, 5),
        )  # fmt: skip


def _check(fac: Facility, base: OperatingConfig, x: np.ndarray, window: Window, tier: float, water: bool = True):
    """(feasible at `tier`, makeup m3, energy kWh) of a candidate."""
    st = simulate(fac, _controls(base, x), window.ambient)
    ok = bool(st.tower_solved.all() or not st.wet_on.any())
    ok = ok and bool((constraint_vector(fac, base, st, tier, water) >= -1e-9).all())
    return ok, *_totals(st)


def _least_water(fac: Facility, base: OperatingConfig, window: Window, start: np.ndarray, reference):
    """Lowest makeup that respects the equipment limits, ignoring the water
    allocation. Used to explain an infeasible window. Returns (x, makeup) or None."""
    problem = _Problem(fac, base, window, Objective(w_water=1.0, w_energy=0.0), reference, 0.1, water=False)
    best: tuple[float, np.ndarray] | None = None
    for x0 in (start, np.array([0.5, 0.5, 0.6, fac.coc_max, fac.chw_supply_max_c - 1.0])):
        result = minimize(
            problem.cost, problem.z(x0), method="SLSQP", bounds=[(0.0, 1.0)] * len(VARIABLES),
            constraints=[{"type": "ineq", "fun": problem.constraints}],
            options={"maxiter": 50, "ftol": 1e-7, "eps": 1e-4},
        )  # fmt: skip
        x = problem.x(np.clip(result.x, 0.0, 1.0))
        ok, makeup, _ = _check(fac, base, x, window, 0.0, water=False)
        if ok and (best is None or makeup < best[0]):
            best = (makeup, x)
    dry = _all_dry_candidate(fac, base, 0.0)
    ok, makeup, _ = _check(fac, base, dry, window, 0.0, water=False)
    if ok and (best is None or makeup < best[0]):
        best = (makeup, dry)
    return None if best is None else (best[1], best[0])


def _all_dry_candidate(fac: Facility, base: OperatingConfig, tier: float) -> np.ndarray:
    """Towers off: only the chilled-water set point still matters, and warmer
    is always better, so take the warmest the server inlet limit allows."""
    approach = fac.crah_approach_design_k * (0.4 + 0.6 * base.it_load_kw / fac.it_design_kw)
    warmest = min(fac.chw_supply_max_c, fac.server_inlet_limit_c - approach - tier * 1.0)
    chw = max(fac.chw_supply_min_c, np.floor(warmest * 10.0 + 1e-9) / 10.0)
    x = _vector(base)
    x[0], x[4] = 0.0, chw
    return x


def optimise(
    fac: Facility,
    base: OperatingConfig,
    window: Window,
    objective: Objective,
    reference: tuple[float, float],
) -> tuple[OperatingConfig, SolverInfo]:
    """Best feasible configuration for one objective, or the least-violating
    one with `status="infeasible"` when no configuration satisfies the limits."""
    started = time.perf_counter()
    lo, hi = _bounds(fac)
    evaluations = 0
    least_bad: tuple[float, np.ndarray] | None = None

    # (search tier, acceptance tier): operating margins first, bare limits second.
    for search_tier, accept_tier in ((_SEARCH_TIER, 1.0), (0.1, 0.0)):
        problem = _Problem(fac, base, window, objective, reference, search_tier)
        seeds = [
            problem.z(_vector(base)),
            problem.z(np.array([0.55, 0.65, 0.70, fac.coc_max, fac.chw_supply_max_c - 2.0])),
            problem.z(np.array([1.00, 0.80, 0.80, fac.coc_max, fac.chw_supply_max_c - 2.0])),
        ]
        constraint = {"type": "ineq", "fun": problem.constraints}
        best: tuple[float, np.ndarray] | None = None
        for z0 in seeds:
            result = minimize(
                problem.cost, z0, method="SLSQP", bounds=[(0.0, 1.0)] * len(VARIABLES),
                constraints=[constraint], options={"maxiter": 50, "ftol": 1e-7, "eps": 1e-4},
            )  # fmt: skip
            z = np.clip(result.x, 0.0, 1.0)
            x_raw = problem.x(z)
            violation = float(np.maximum(-problem.constraints(z), 0.0).max())
            if least_bad is None or violation < least_bad[0]:
                least_bad = (violation, x_raw)
            rounded = np.clip(np.round(x_raw / _ROUNDING) * _ROUNDING, lo, hi)
            for x in (rounded, x_raw):
                ok, makeup, energy = _check(fac, base, x, window, accept_tier)
                if ok:
                    cost = problem.objective_value(makeup, energy).value
                    if best is None or cost < best[0] - 1e-9:
                        best = (cost, x)
                    break
        dry = _all_dry_candidate(fac, base, accept_tier)
        ok, makeup, energy = _check(fac, base, dry, window, accept_tier)
        if ok:
            cost = problem.objective_value(makeup, energy).value
            if best is None or cost < best[0] - 1e-9:
                best = (cost, dry)
        evaluations += problem.evaluations
        if best is not None:
            kept = accept_tier > 0
            return _config(base, best[1]), SolverInfo(
                method=_METHOD, status="optimal",
                message=(
                    "Optimum found with an operating margin kept from every limit."
                    if kept else
                    "Optimum found on the limits: the operating margins could not all be kept."
                ),
                evaluations=evaluations, starts=len(seeds),
                runtime_ms=round((time.perf_counter() - started) * 1e3, 1),
            )  # fmt: skip

    # Infeasible. Say why: is it the water allocation, or the equipment itself?
    allocation = base.water_allocation_m3_day * window.hours / 24.0
    floor = _least_water(fac, base, window, least_bad[1], reference)
    if floor is not None:
        x, makeup = floor
        message = (
            f"The water allocation cannot be met. The lowest makeup that respects every equipment "
            f"limit is {makeup:.0f} m³ against an allocation of {allocation:.0f} m³ for the window."
        )
    else:
        x = least_bad[1]
        message = "The equipment limits cannot all be met in this window, whatever the set points."
    return _config(base, x), SolverInfo(
        method=_METHOD, status="infeasible", message=message, evaluations=evaluations, starts=3,
        runtime_ms=round((time.perf_counter() - started) * 1e3, 1),
    )  # fmt: skip


# --- scenarios -------------------------------------------------------------------
def changes_between(before: OperatingConfig, after: OperatingConfig) -> list[ParameterChange]:
    out = []
    for key, (label, unit, scale) in PARAMETER_META.items():
        a, b = float(getattr(before, key)) * scale, float(getattr(after, key)) * scale
        if abs(a - b) > 1e-6:
            out.append(ParameterChange(key=key, label=label, unit=unit, before=round(a, 2), after=round(b, 2)))
    return out


def _water_row(summary: WindowSummary) -> Constraint:
    margin = summary.allocation_m3 - summary.makeup_m3
    if margin < -1e-6:
        status = "violated"
    elif margin < WATER_MARGIN * summary.allocation_m3 - 1e-6:
        status = "warning"
    else:
        status = "ok"
    return Constraint(
        id="water_allocation", label="Makeup water in the window", value=summary.makeup_m3,
        limit=summary.allocation_m3, unit="m³", kind="max", margin=round(margin, 2), status=status,
        detail="Water allocation for the window",
    )  # fmt: skip


def _pct(delta: float, base: float) -> float | None:
    return round(delta / base * 100.0, 2) if abs(base) > 1e-9 else None


def _explain(rows: list[Constraint], summary: WindowSummary, hours: int) -> list[str]:
    """Why a configuration is infeasible: what is broken and what is binding."""
    out = []
    for r in rows:
        if r.status == "violated":
            out.append(f"{r.label}: {r.value:.4g} {r.unit} against a limit of {r.limit:.4g} {r.unit}.")
    if summary.infeasible_hours and not any(r.status == "violated" and r.id != "water_allocation" for r in rows):
        out.append(f"{summary.infeasible_hours} of {hours} hours break an equipment limit.")
    binding = [f"{r.label.lower()} ({r.value:.4g} of {r.limit:.4g} {r.unit})" for r in rows if r.status == "warning"]
    if out and binding:
        out.append("No room left to compensate: " + ", ".join(binding) + ".")
    return out


def build_scenario(
    fac: Facility,
    key: str,
    label: str,
    description: str,
    cfg: OperatingConfig,
    base: OperatingConfig,
    window: Window,
    *,
    baseline: WindowSummary | None,
    solver: SolverInfo,
    tank_start: float | None = None,
) -> Scenario:
    st, projection = project(
        fac, cfg, window.times, window.ambient, ambient_source=window.source, tank_start=tank_start
    )
    summary = projection.horizon
    specs = constraint_specs(fac, cfg.water_allocation_m3_day, st)
    rows = [r for r in worst_constraints(specs, slice(0, window.hours)) if r.id != "water_rate"]
    rows.append(_water_row(summary))
    feasible = summary.infeasible_hours == 0 and all(r.status != "violated" for r in rows)

    deltas = None
    if baseline is not None:
        max_cws = None
        if summary.max_cws_c is not None and baseline.max_cws_c is not None:
            max_cws = round(summary.max_cws_c - baseline.max_cws_c, 2)
        deltas = Deltas(
            makeup_m3=round(summary.makeup_m3 - baseline.makeup_m3, 2),
            makeup_pct=_pct(summary.makeup_m3 - baseline.makeup_m3, baseline.makeup_m3),
            energy_kwh=round(summary.cooling_energy_kwh - baseline.cooling_energy_kwh, 1),
            energy_pct=_pct(summary.cooling_energy_kwh - baseline.cooling_energy_kwh, baseline.cooling_energy_kwh),
            peak_power_kw=round(summary.peak_power_kw - baseline.peak_power_kw, 1),
            max_cws_k=max_cws,
        )
    return Scenario(
        key=key, label=label, description=description, config=cfg, feasible=feasible,
        objective=None, summary=summary, deltas=deltas,
        changes=changes_between(base, cfg), constraints=rows, solver=solver,
        infeasibility=[] if feasible else _explain(rows, summary, window.hours),
        hourly_makeup_m3_h=projection.makeup_m3_h, hourly_power_kw=projection.cooling_power_kw,
        hourly_cws_c=projection.cws_c, hourly_tank_level_pct=projection.tank_level_pct,
    )  # fmt: skip


def tradeoff_curve(
    fac: Facility, cfg: OperatingConfig, window: Window, objective: Objective, points: int = 21
) -> list[TradeoffPoint]:
    """Water against energy as the evaporative share goes from all-dry to
    all-wet. For each share the tower fan speed is the best feasible one from
    a fixed grid; the other set points are held. One vectorised solve."""
    shares = np.linspace(0.0, 1.0, points)
    fans = np.linspace(fac.tower_fan_speed_min, 1.0, 10)
    ctl = Controls.from_config(cfg)
    ctl.wet_fraction = shares[:, None, None]
    ctl.tower_fan_speed = fans[None, :, None]
    st = simulate(fac, ctl, window.ambient)
    allocation = cfg.water_allocation_m3_day * window.hours / 24.0
    specs = constraint_specs(fac, cfg.water_allocation_m3_day, st)
    makeup = st.makeup_m3_h.sum(axis=2)
    energy = st.cooling_power_kw.sum(axis=2)
    ok = hard_feasible(specs, st).all(axis=2) & (makeup <= allocation + 1e-6)
    cost = objective.w_water * makeup / max(float(makeup.max()), 1e-6)
    cost = cost + objective.w_energy * energy / float(energy.max())
    out = []
    for k, share in enumerate(shares):
        pool = np.flatnonzero(ok[k]) if ok[k].any() else np.arange(fans.size)
        j = int(pool[np.argmin(cost[k][pool])])
        out.append(
            TradeoffPoint(
                wet_fraction=round(float(share), 3), makeup_m3=round(float(makeup[k, j]), 2),
                energy_kwh=round(float(energy[k, j]), 1), feasible=bool(ok[k].any()),
            )  # fmt: skip
        )
    return out


def optimise_scenarios(
    fac: Facility,
    base: OperatingConfig,
    window: Window,
    water_saving: Objective,
    balanced: Objective,
    tank_start: float | None = None,
) -> OptimizationResult:
    """Baseline, water-saving and balanced configurations for one window."""
    untouched = SolverInfo(method="none", status="baseline", message="Applied configuration, not optimised.")
    reference = _totals(simulate(fac, Controls.from_config(base), window.ambient))

    def objective_for(obj: Objective, summary: WindowSummary) -> ObjectiveValue:
        problem = _Problem(fac, base, window, obj, reference, 0.0)
        return problem.objective_value(summary.makeup_m3, summary.cooling_energy_kwh)

    baseline = build_scenario(
        fac, "baseline", "Current", "The configuration applied to the facility now.",
        base, base, window, baseline=None, solver=untouched, tank_start=tank_start,
    )  # fmt: skip
    baseline.objective = objective_for(balanced, baseline.summary)

    scenarios = [baseline]
    for key, label, description, obj in (
        ("water_saving", "Water-saving", "Least makeup water within every limit.", water_saving),
        ("balanced", "Balanced", "Best combined water and cooling-energy result.", balanced),
    ):
        cfg, info = optimise(fac, base, window, obj, reference)
        scenario = build_scenario(
            fac, key, label, description, cfg, base, window,
            baseline=baseline.summary, solver=info, tank_start=tank_start,
        )  # fmt: skip
        scenario.objective = objective_for(obj, scenario.summary)
        if info.status == "infeasible":
            scenario.feasible = False
            rest = [m for m in scenario.infeasibility if not m.startswith("Makeup water in the window")]
            scenario.infeasibility = [info.message, *rest]
        scenarios.append(scenario)

    recommended, reason = recommend(baseline, scenarios[1], scenarios[2], fac)
    curve_cfg = scenarios[2].config if scenarios[2].feasible else base
    return OptimizationResult(
        generated_at=datetime.now(timezone.utc),
        window_hours=window.hours,
        window_start=window.times[0] if window.times else None,
        window_end=baseline.summary.end,
        ambient_source=window.source,
        times=window.times,
        scenarios=scenarios,
        tradeoff=tradeoff_curve(fac, curve_cfg, window, balanced),
        recommended=recommended,
        recommendation_reason=reason,
    )


def recommend(baseline: Scenario, water: Scenario, balanced: Scenario, fac: Facility) -> tuple[str, str]:
    """Deterministic choice of the strategy to put in front of the operator."""
    base = baseline.summary
    utilisation = base.allocation_utilisation or 0.0
    tank_floor = fac.tank_reserve_fraction * 100.0 + 10.0
    if not baseline.feasible:
        for candidate in (balanced, water):
            if candidate.feasible:
                return candidate.key, (
                    "The current configuration breaks a limit in this window; "
                    f"the {candidate.label.lower()} configuration satisfies all of them."
                )
        return "baseline", "No feasible configuration exists for this window. Review the constraints."
    if (utilisation >= 0.9 or base.min_tank_level_pct < tank_floor) and water.feasible:
        return "water_saving", (
            f"Projected makeup uses {utilisation * 100:.0f} % of the water allocation and the tank "
            f"falls to {base.min_tank_level_pct:.0f} %, so water takes priority."
        )
    if balanced.feasible and balanced.objective and baseline.objective:
        if baseline.objective.value - balanced.objective.value > 0.005:
            return "balanced", (
                "Water supply is not under stress, so the balanced configuration gives the best "
                "combined water and energy result within every limit."
            )
    return "baseline", "The current configuration is already within 0.5 % of the balanced optimum."
