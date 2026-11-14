"""Turn a solved `PlantState` into structured, traceable results:
constraints, stress index, warnings and per-equipment states."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime

import numpy as np

from .facility import Facility, OperatingConfig
from .physics import psychro as ps
from .physics.plant import M3H_PER_KGS, PlantState, wet_cooling_capacity
from .schemas import (
    Capacity,
    Conditions,
    Constraint,
    Energy,
    EquipmentState,
    Metric,
    PointResult,
    Stress,
    Thermal,
    Water,
)

STRESS_LIMITS = (0.65, 0.80, 0.95)  # elevated, high, critical
THERMAL_STRESS_SPAN_K = 10.0  # CWS headroom that maps to zero thermal stress


def stress_level(index: float) -> str:
    if index >= STRESS_LIMITS[2]:
        return "critical"
    if index >= STRESS_LIMITS[1]:
        return "high"
    if index >= STRESS_LIMITS[0]:
        return "elevated"
    return "nominal"


def stress_components(fac: Facility, st: PlantState, allocation_m3_day: float) -> dict:
    """Dimensionless utilisations; 1.0 means a limit is reached."""
    thermal = np.where(
        st.wet_on, np.maximum(1.0 - st.margins["cws_high"] / THERMAL_STRESS_SPAN_K, 0.0), 0.0
    )
    chillers = st.q_wet_kw / (fac.wc_chiller_count * fac.wc_chiller_capacity_kw)
    dry = np.where(st.q_dry_kw > 1.0, st.q_dry_kw / st.dry_capacity_kw, 0.0)
    demand = st.makeup_m3_h * 24.0
    if allocation_m3_day > 0:
        water = demand / allocation_m3_day
    else:
        water = np.where(demand > 0.01, 2.0, 0.0)
    return {
        "Condenser water temperature": thermal,
        "Water-cooled chiller loading": chillers,
        "Dry plant loading": dry,
        "Water allocation": water,
    }


def stress_index(components: dict) -> tuple[np.ndarray, list[str]]:
    names = list(components)
    stacked = np.stack([components[n] for n in names])
    index = stacked.max(axis=0)
    drivers = [names[k] for k in stacked.argmax(axis=0)]
    return index, drivers


# --- constraints ---------------------------------------------------------------
@dataclass
class _Spec:
    id: str
    label: str
    unit: str
    kind: str  # "max" or "min"
    value: np.ndarray
    limit: np.ndarray
    warn: np.ndarray  # warning band, in the unit of the margin
    applicable: np.ndarray
    detail: str
    hard: bool = True

    def margin(self) -> np.ndarray:
        return self.limit - self.value if self.kind == "max" else self.value - self.limit

    @property
    def scale(self) -> float:
        """Typical size of the margin, used to put constraints on one scale."""
        return {"°C": 5.0, "K": 5.0, "%": 100.0, "kW": 10_000.0}.get(self.unit, 1.0)


def _full(st: PlantState, value) -> np.ndarray:
    return np.broadcast_to(np.asarray(value, dtype=float), st.t_db_c.shape)


def constraint_specs(fac: Facility, allocation_m3_day: float, st: PlantState) -> list[_Spec]:
    dry_on = st.q_dry_kw > 1.0
    always = np.ones(st.t_db_c.shape, dtype=bool)
    cell_flow_pct = np.where(
        st.wet_on,
        st.cw_flow_kg_s / st.cells_online / fac.tower_design_cell_water_kg_s * 100.0,
        0.0,
    )
    wc_installed = fac.wc_chiller_count * fac.wc_chiller_capacity_kw
    demand = st.makeup_m3_h * 24.0
    return [
        _Spec(
            "cws_high", "Condenser water supply", "°C", "max", st.t_cws_c,
            _full(st, fac.cws_max_c), _full(st, 1.0), st.wet_on,
            "Chiller condenser entering-water limit",
        ),
        _Spec(
            "cws_low", "Condenser water supply (min)", "°C", "min", st.t_cws_c,
            _full(st, fac.cws_min_c), _full(st, 1.0), st.wet_on,
            "Minimum for stable chiller head pressure",
        ),
        _Spec(
            "cw_range", "Condenser water range", "K", "max", st.range_k,
            _full(st, fac.cw_range_max_k), _full(st, 1.0), st.wet_on,
            "Maximum temperature rise across the chiller condensers",
        ),
        _Spec(
            "cell_flow_low", "Tower cell water loading (min)", "%", "min", cell_flow_pct,
            _full(st, fac.tower_cell_flow_min * 100.0), _full(st, 5.0), st.wet_on,
            "Minimum flow that keeps the tower fill fully wetted",
        ),
        _Spec(
            "cell_flow_high", "Tower cell water loading (max)", "%", "max", cell_flow_pct,
            _full(st, fac.tower_cell_flow_max * 100.0), _full(st, 5.0), st.wet_on,
            "Hydraulic limit of the tower distribution system",
        ),
        _Spec(
            "wc_chiller_capacity", "Water-cooled chiller load", "kW", "max", st.q_wet_kw,
            _full(st, wc_installed), _full(st, fac.wc_chiller_capacity_kw), st.wet_on,
            "Installed capacity; the warning band is the N+1 standby unit",
        ),
        _Spec(
            "dry_capacity", "Dry plant load", "kW", "max", st.q_dry_kw,
            st.dry_capacity_kw, 0.1 * st.dry_capacity_kw, dry_on,
            "Air-cooled capacity derated for the ambient dry-bulb",
        ),
        _Spec(
            "dry_condensing", "Air-cooled condensing temperature", "°C", "max",
            st.dry_t_cond_c, _full(st, fac.ac_condensing_limit_c), _full(st, 4.0), dry_on,
            "Compressor envelope limit",
        ),
        _Spec(
            "server_inlet", "Server inlet temperature", "°C", "max", st.server_inlet_c,
            _full(st, fac.server_inlet_limit_c), _full(st, 1.0), always,
            "ASHRAE TC 9.9 recommended upper limit, class A1",
        ),
        _Spec(
            "coc", "Cycles of concentration", "", "max", st.coc,
            _full(st, fac.coc_max), _full(st, 0.0), st.wet_on,
            "Assumed scaling limit of the makeup-water chemistry",
        ),
        _Spec(
            "water_rate", "Makeup demand rate", "m³/day", "max", demand,
            _full(st, allocation_m3_day), _full(st, 0.1 * allocation_m3_day), always,
            "Above the allocation the plant draws down stored water",
            hard=False,
        ),
    ]  # fmt: skip


def _row(spec: _Spec, i: int | None) -> Constraint:
    if i is None or not bool(spec.applicable[i]):
        return Constraint(
            id=spec.id, label=spec.label, value=None, limit=_num(spec.limit.flat[0]),
            unit=spec.unit, kind=spec.kind, margin=None, status="n/a", detail=spec.detail,
        )  # fmt: skip
    margin = float(spec.margin()[i])
    if margin < -1e-6:
        status = "violated" if spec.hard else "warning"
    elif margin < float(spec.warn[i]):
        status = "warning"
    else:
        status = "ok"
    return Constraint(
        id=spec.id, label=spec.label, value=_num(spec.value[i]), limit=_num(spec.limit[i]),
        unit=spec.unit, kind=spec.kind, margin=_num(margin), status=status, detail=spec.detail,
    )  # fmt: skip


def constraints_at(specs: list[_Spec], i: int) -> list[Constraint]:
    return [_row(s, i) for s in specs]


def worst_constraints(specs: list[_Spec], window: slice) -> list[Constraint]:
    """For each constraint, the hour of the window with the smallest margin."""
    rows = []
    for spec in specs:
        idx = np.arange(spec.value.shape[0])[window]
        idx = idx[spec.applicable[window]]
        if idx.size == 0:
            rows.append(_row(spec, None))
            continue
        rows.append(_row(spec, int(idx[np.argmin(spec.margin()[idx])])))
    return rows


def scaled_margins(specs: list[_Spec], tier: float) -> np.ndarray:
    """Hard-constraint margins for the optimiser, of order one and >= 0 when
    satisfied. `tier` 1 keeps the warning band of every limit as an operating
    margin; `tier` 0 only respects the limits themselves."""
    parts = []
    for spec in specs:
        if not spec.hard or spec.id == "coc":  # COC is a simple bound
            continue
        value = (spec.margin() - tier * spec.warn) / spec.scale
        parts.append(np.where(spec.applicable, np.minimum(value, 5.0), 1.0).ravel())
    return np.concatenate(parts)


def hard_feasible(specs: list[_Spec], st: PlantState) -> np.ndarray:
    ok = np.asarray(st.tower_solved | ~st.wet_on)
    for spec in specs:
        if spec.hard:
            ok = ok & (~spec.applicable | (spec.margin() >= -1e-6))
    return ok


# --- point result ----------------------------------------------------------------
def _num(x, digits: int = 4) -> float:
    v = float(x)
    return round(v, digits) if math.isfinite(v) else 0.0


def _opt(x, on: bool, digits: int = 3) -> float | None:
    return _num(x, digits) if on else None


def point_result(
    fac: Facility,
    cfg: OperatingConfig,
    st: PlantState,
    i: int = 0,
    *,
    time: datetime | None = None,
    source: str = "forecast",
    wind_ms: float = 3.0,
    ghi_w_m2: float = 0.0,
    tank_fraction: float | None = None,
) -> PointResult:
    wet_on = bool(st.wet_on[i])
    dry_on = bool(st.q_dry_kw[i] > 1.0)
    tank_fraction = fac.tank_initial_fraction if tank_fraction is None else tank_fraction

    wet_cap, tower_cap = wet_cooling_capacity(fac, st)
    cooling_capacity = float(wet_cap[i] + st.dry_capacity_kw[i])
    q_cool = float(st.q_cool_kw[i])
    makeup = float(st.makeup_m3_h[i])
    tank_volume = tank_fraction * fac.tank_capacity_m3
    alloc = cfg.water_allocation_m3_day

    conditions = Conditions(
        time=time, source=source, t_db_c=_num(st.t_db_c[i], 2), t_wb_c=_num(st.t_wb_c[i], 2),
        rh_pct=_num(st.rh[i] * 100.0, 1), pressure_hpa=_num(st.pressure_pa[i] / 100.0, 1),
        wind_ms=_num(wind_ms, 1), ghi_w_m2=_num(ghi_w_m2, 0),
    )  # fmt: skip

    q_rej_wet = float(st.q_rej_wet_kw[i])
    thermal = Thermal(
        it_load_kw=_num(st.it_kw[i], 1),
        envelope_gain_kw=_num(st.q_env_kw[i], 1),
        cooling_load_kw=_num(q_cool, 1),
        wet_load_kw=_num(st.q_wet_kw[i], 1),
        dry_load_kw=_num(st.q_dry_kw[i], 1),
        wet_fraction=_num(st.wet_fraction[i], 4),
        heat_rejection_kw=_num(st.heat_rejection_kw[i], 1),
        heat_rejection_wet_kw=_num(q_rej_wet, 1),
        heat_rejection_dry_kw=_num(st.q_rej_dry_kw[i], 1),
        latent_kw=_num(st.q_latent_kw[i], 1),
        sensible_kw=_num(st.q_sensible_kw[i], 1),
        latent_fraction=_opt(st.q_latent_kw[i] / q_rej_wet if wet_on else 0.0, wet_on),
        chw_supply_c=_num(st.chw_supply_c[i], 2),
        chw_return_c=_num(st.chw_supply_c[i] + fac.chw_delta_t_k, 2),
        chw_flow_m3_h=_num(q_cool / (ps.CP_W * fac.chw_delta_t_k) * M3H_PER_KGS, 1),
        cws_c=_opt(st.t_cws_c[i], wet_on, 2),
        cwr_c=_opt(st.t_cwr_c[i], wet_on, 2),
        range_k=_opt(st.range_k[i], wet_on, 2),
        approach_k=_opt(st.approach_k[i], wet_on, 2),
        cw_flow_m3_h=_num(st.cw_flow_kg_s[i] * M3H_PER_KGS, 1),
        tower_air_flow_kg_s=_num(st.air_flow_kg_s[i], 1),
        tower_air_out_c=_opt(st.t_air_out_c[i], wet_on, 2),
        lg_ratio=_opt(st.cw_flow_kg_s[i] / max(float(st.air_flow_kg_s[i]), 1e-9), wet_on),
        ntu=_opt(st.ntu[i], wet_on),
        wc_cop=_opt(st.wc_cop[i], wet_on, 2),
        ac_cop=_opt(st.dry_cop[i], dry_on, 2),
        ac_condensing_c=_opt(st.dry_t_cond_c[i], dry_on, 2),
        server_inlet_c=_num(st.server_inlet_c[i], 2),
    )

    evap, blow, drift = (
        float(st.evaporation_m3_h[i]), float(st.blowdown_m3_h[i]), float(st.drift_m3_h[i])
    )  # fmt: skip
    water = Water(
        evaporation_m3_h=_num(evap),
        blowdown_m3_h=_num(blow),
        drift_m3_h=_num(drift),
        makeup_m3_h=_num(makeup),
        makeup_m3_day=_num(makeup * 24.0, 1),
        balance_residual_m3_h=_num(makeup - (evap + blow + drift), 9),
        cycles_of_concentration=_num(st.coc[i], 2),
        evaporation_pct_of_flow=_opt(
            st.evaporation_kg_s[i] / max(float(st.cw_flow_kg_s[i]), 1e-9) * 100.0, wet_on
        ),
        wue_l_kwh=_num(st.wue_l_kwh[i], 3),
        allocation_m3_day=_num(alloc, 1),
        allocation_utilisation=_num(makeup * 24.0 / alloc, 3) if alloc > 0 else None,
        tank_level_pct=_num(tank_fraction * 100.0, 1),
        tank_volume_m3=_num(tank_volume, 0),
        autonomy_h=_num(tank_volume / makeup, 1) if makeup > 1e-6 else None,
    )

    energy = Energy(
        wc_chiller_kw=_num(st.wc_comp_kw[i], 1),
        ac_chiller_kw=_num(st.dry_comp_kw[i], 1),
        tower_fan_kw=_num(st.tower_fan_kw[i], 1),
        cw_pump_kw=_num(st.cw_pump_kw[i], 1),
        chw_pump_kw=_num(st.chw_pump_kw[i], 1),
        ac_fan_kw=_num(st.dry_fan_kw[i], 1),
        crah_fan_kw=_num(st.crah_fan_kw[i], 1),
        cooling_power_kw=_num(st.cooling_power_kw[i], 1),
        ppue=_num(st.ppue[i], 4),
        kw_per_kw_cooling=_num(st.cooling_power_kw[i] / q_cool, 4),
    )

    capacity = Capacity(
        cooling_capacity_kw=_num(cooling_capacity, 0),
        wet_capacity_kw=_num(wet_cap[i], 0),
        dry_capacity_kw=_num(st.dry_capacity_kw[i], 0),
        tower_rejection_capacity_kw=_num(tower_cap[i], 0),
        margin_kw=_num(cooling_capacity - q_cool, 0),
        utilisation=_num(q_cool / cooling_capacity, 3),
    )

    specs = constraint_specs(fac, alloc, st)
    constraints = constraints_at(specs, i)
    feasible = bool(hard_feasible(specs, st)[i])

    components = stress_components(fac, st, alloc)
    index, drivers = stress_index(components)
    stress = Stress(
        index=_num(index[i], 3),
        level=stress_level(float(index[i])),
        driver=drivers[i],
        components={k: _num(v[i], 3) for k, v in components.items()},
    )

    return PointResult(
        conditions=conditions, config=cfg, thermal=thermal, water=water, energy=energy,
        capacity=capacity, constraints=constraints, stress=stress, feasible=feasible,
        warnings=_warnings(fac, cfg, st, i, constraints),
        equipment=equipment_states(fac, cfg, st, i, tank_fraction),
    )  # fmt: skip


def _warnings(fac, cfg, st, i, constraints) -> list[str]:
    out: list[str] = []
    wet_on = bool(st.wet_on[i])
    if wet_on and not bool(st.tower_solved[i]):
        out.append("Towers cannot reject the wet-plant heat load at these settings.")
    for c in constraints:
        if c.status == "violated":
            out.append(f"{c.label} {c.value:g} {c.unit} violates its limit of {c.limit:g} {c.unit}.")
        elif c.status == "warning" and c.id == "water_rate" and (c.margin or 0) < 0:
            out.append(
                f"Makeup demand rate {c.value:.0f} m³/day exceeds the {c.limit:.0f} m³/day "
                "allocation; stored water is being drawn down."
            )
        elif c.status == "warning":
            out.append(f"{c.label} {c.value:g} {c.unit} is close to its limit of {c.limit:g} {c.unit}.")
    if wet_on and cfg.tower_cells_online < fac.tower_cells_duty:
        missing = fac.tower_cell_count - cfg.tower_cells_online
        out.append(f"{missing} of {fac.tower_cell_count} tower cells are out of service.")
    if wet_on:
        latent = float(st.q_latent_kw[i] / max(float(st.q_rej_wet_kw[i]), 1e-9))
        if latent > 1.0:
            out.append(
                f"Hot, dry air: latent fraction {latent:.2f}. The tower air is cooled while it "
                "is humidified, so evaporation exceeds what the heat load alone would need."
            )
    else:
        out.append("Wet plant is off: no evaporative water use.")
    return out


# --- equipment ----------------------------------------------------------------------
def _m(label, value, unit="", digits=1) -> Metric:
    return Metric(label=label, value=None if value is None else _num(value, 4), unit=unit, digits=digits)


def _running_count(load_kw: float, unit_capacity_kw: float, installed: int) -> int:
    if load_kw <= 1.0:
        return 0
    return int(min(installed, max(1, math.ceil(load_kw / (0.9 * unit_capacity_kw)))))


def equipment_states(
    fac: Facility, cfg: OperatingConfig, st: PlantState, i: int, tank_fraction: float
) -> list[EquipmentState]:
    out: list[EquipmentState] = []
    wet_on = bool(st.wet_on[i])
    q_wet, q_dry = float(st.q_wet_kw[i]), float(st.q_dry_kw[i])
    t_chws = float(st.chw_supply_c[i])
    t_chwr = t_chws + fac.chw_delta_t_k
    cws, cwr = float(st.t_cws_c[i]), float(st.t_cwr_c[i])
    cws_margin = float(st.margins["cws_high"][i])
    cw_flow = float(st.cw_flow_kg_s[i]) * M3H_PER_KGS
    chw_flow = float(st.q_cool_kw[i]) / (ps.CP_W * fac.chw_delta_t_k) * M3H_PER_KGS
    makeup = float(st.makeup_m3_h[i])
    it = float(st.it_kw[i])

    # data hall
    inlet = float(st.server_inlet_c[i])
    inlet_margin = fac.server_inlet_limit_c - inlet
    out.append(
        EquipmentState(
            id="DH-01", tag="DH-01", name="Data hall", kind="hall",
            state="fault" if inlet_margin < 0 else "warning" if inlet_margin < 1.0 else "running",
            summary=f"{it / 1000:.2f} MW IT across {fac.rack_count} racks",
            metrics=[
                _m("IT load", it, "kW", 0),
                _m("Load ratio", it / fac.it_design_kw * 100, "%", 0),
                _m("Mean rack density", it / fac.rack_count, "kW/rack", 1),
                _m("Cooling load", st.q_cool_kw[i], "kW", 0),
                _m("Envelope and ventilation gain", st.q_env_kw[i], "kW", 0),
                _m("Server inlet", inlet, "°C", 1),
                _m("CRAH fan power", st.crah_fan_kw[i], "kW", 0),
            ],
        )  # fmt: skip
    )

    # water-cooled chillers
    n_wc = _running_count(q_wet, fac.wc_chiller_capacity_kw, fac.wc_chiller_count)
    overloaded = q_wet > fac.wc_chiller_count * fac.wc_chiller_capacity_kw
    for k in range(fac.wc_chiller_count):
        running = k < n_wc
        load = q_wet / n_wc if running else 0.0
        state = "standby"
        if running:
            state = "fault" if overloaded or cws_margin < 0 else "warning" if cws_margin < 1.5 else "running"
        out.append(
            EquipmentState(
                id=f"CH-{k + 1:02d}", tag=f"CH-{k + 1:02d}", name="Water-cooled chiller",
                kind="wc_chiller", state=state,
                summary=f"{load:.0f} kW at COP {float(st.wc_cop[i]):.1f}" if running else "Standby",
                metrics=[
                    _m("Cooling load", load, "kW", 0),
                    _m("Part load", load / fac.wc_chiller_capacity_kw * 100, "%", 0),
                    _m("COP", float(st.wc_cop[i]) if running else None, "", 2),
                    _m("Compressor power", float(st.wc_comp_kw[i]) / n_wc if running else 0.0, "kW", 0),
                    _m("Chilled water supply", t_chws, "°C", 1),
                    _m("Chilled water return", t_chwr, "°C", 1),
                    _m("Condenser water in", cws if running else None, "°C", 1),
                    _m("Condenser water out", cwr if running else None, "°C", 1),
                ],
            )  # fmt: skip
        )

    # air-cooled chillers (dry plant)
    unit_cap = float(st.dry_capacity_kw[i]) / fac.ac_chiller_count
    n_ac = _running_count(q_dry, unit_cap, fac.ac_chiller_count)
    dry_over = q_dry > float(st.dry_capacity_kw[i]) + 1e-6
    cond_margin = fac.ac_condensing_limit_c - float(st.dry_t_cond_c[i])
    for k in range(fac.ac_chiller_count):
        running = k < n_ac
        load = q_dry / n_ac if running else 0.0
        state = "standby"
        if running:
            state = "fault" if dry_over or cond_margin < 0 else "warning" if cond_margin < 4 or load > 0.9 * unit_cap else "running"
        out.append(
            EquipmentState(
                id=f"ACC-{k + 1:02d}", tag=f"ACC-{k + 1:02d}", name="Air-cooled chiller",
                kind="ac_chiller", state=state,
                summary=f"{load:.0f} kW at COP {float(st.dry_cop[i]):.1f}" if running else "Standby",
                metrics=[
                    _m("Cooling load", load, "kW", 0),
                    _m("Derated capacity", unit_cap, "kW", 0),
                    _m("COP", float(st.dry_cop[i]) if running else None, "", 2),
                    _m("Compressor power", float(st.dry_comp_kw[i]) / n_ac if running else 0.0, "kW", 0),
                    _m("Condensing temperature", float(st.dry_t_cond_c[i]) if running else None, "°C", 1),
                    _m("Ambient dry-bulb", st.t_db_c[i], "°C", 1),
                    _m("Fan power", float(st.dry_fan_kw[i]) / n_ac if running else 0.0, "kW", 0),
                ],
            )  # fmt: skip
        )

    # cooling tower cells
    cells = int(cfg.tower_cells_online) if wet_on else 0
    for k in range(fac.tower_cell_count):
        running = k < cells
        if running:
            state = "fault" if cws_margin < 0 else "warning" if cws_margin < 1.5 else "running"
            summary = f"Fan {float(st.fan_speed[i]) * 100:.0f} %, approach {float(st.approach_k[i]):.1f} K"
        elif wet_on and k >= cfg.tower_cells_online and cfg.tower_cells_online < fac.tower_cells_duty:
            state, summary = "fault", "Out of service"
        elif wet_on:
            state, summary = "standby", "Standby (N+1)"
        else:
            state, summary = "off", "Wet plant off"
        share = 1.0 / cells if running else 0.0
        out.append(
            EquipmentState(
                id=f"CT-{k + 1:02d}", tag=f"CT-{k + 1:02d}", name="Cooling tower cell",
                kind="tower", state=state, summary=summary,
                metrics=[
                    _m("Fan speed", float(st.fan_speed[i]) * 100 if running else 0.0, "%", 0),
                    _m("Fan power", float(st.tower_fan_kw[i]) * share, "kW", 1),
                    _m("Heat rejection", float(st.q_rej_wet_kw[i]) * share, "kW", 0),
                    _m("Water flow", cw_flow * share, "m³/h", 0),
                    _m("Air flow", float(st.air_flow_kg_s[i]) * share, "kg/s", 0),
                    _m("Water in", cwr if running else None, "°C", 1),
                    _m("Water out", cws if running else None, "°C", 1),
                    _m("Approach to wet-bulb", float(st.approach_k[i]) if running else None, "K", 1),
                    _m("Evaporation", float(st.evaporation_m3_h[i]) * share, "m³/h", 2),
                    _m("Leaving air", float(st.t_air_out_c[i]) if running else None, "°C", 1),
                ],
            )  # fmt: skip
        )

    # pumps
    duty_cw = fac.cw_pump_count - 1
    for k in range(fac.cw_pump_count):
        running = wet_on and k < duty_cw
        out.append(
            EquipmentState(
                id=f"CWP-{k + 1:02d}", tag=f"CWP-{k + 1:02d}", name="Condenser water pump",
                kind="cw_pump", state="running" if running else "standby" if wet_on else "off",
                summary=f"{float(st.pump_speed[i]) * 100:.0f} % speed" if running else ("Standby (N+1)" if wet_on else "Wet plant off"),
                metrics=[
                    _m("Speed", float(st.pump_speed[i]) * 100 if running else 0.0, "%", 0),
                    _m("Flow", cw_flow / duty_cw if running else 0.0, "m³/h", 0),
                    _m("Power", float(st.cw_pump_kw[i]) / duty_cw if running else 0.0, "kW", 1),
                ],
            )  # fmt: skip
        )
    chw_ratio = float(np.clip(st.q_cool_kw[i] / fac.cooling_load_design_kw, 0.35, 1.2))
    for k in range(5):
        running = k < 4
        out.append(
            EquipmentState(
                id=f"CHP-{k + 1:02d}", tag=f"CHP-{k + 1:02d}", name="Chilled water pump",
                kind="chw_pump", state="running" if running else "standby",
                summary=f"{chw_ratio * 100:.0f} % speed" if running else "Standby (N+1)",
                metrics=[
                    _m("Speed", chw_ratio * 100 if running else 0.0, "%", 0),
                    _m("Flow", chw_flow / 4 if running else 0.0, "m³/h", 0),
                    _m("Power", float(st.chw_pump_kw[i]) / 4 if running else 0.0, "kW", 1),
                ],
            )  # fmt: skip
        )

    # water systems
    alloc = cfg.water_allocation_m3_day
    volume = tank_fraction * fac.tank_capacity_m3
    autonomy = volume / makeup if makeup > 1e-6 else None
    tank_state = "running"
    if tank_fraction < fac.tank_reserve_fraction:
        tank_state = "fault"
    elif tank_fraction < fac.tank_reserve_fraction + 0.15 or (autonomy is not None and autonomy < 24):
        tank_state = "warning"
    out.append(
        EquipmentState(
            id="TK-01", tag="TK-01", name="Water storage tank", kind="tank", state=tank_state,
            summary=f"{tank_fraction * 100:.0f} % full" + (f", {autonomy:.0f} h autonomy" if autonomy else ""),
            metrics=[
                _m("Level", tank_fraction * 100, "%", 0),
                _m("Stored volume", volume, "m³", 0),
                _m("Capacity", fac.tank_capacity_m3, "m³", 0),
                _m("Reserve level", fac.tank_reserve_fraction * 100, "%", 0),
                _m("Autonomy at current demand", autonomy, "h", 0),
            ],
        )  # fmt: skip
    )
    over = alloc > 0 and makeup * 24 > alloc
    out.append(
        EquipmentState(
            id="MU-01", tag="MU-01", name="Makeup water line", kind="makeup",
            state="off" if makeup <= 1e-6 else "warning" if over else "running",
            summary=f"{makeup:.1f} m³/h to the tower basins" if makeup > 1e-6 else "No demand",
            metrics=[
                _m("Makeup flow", makeup, "m³/h", 2),
                _m("Evaporation", st.evaporation_m3_h[i], "m³/h", 2),
                _m("Blowdown", st.blowdown_m3_h[i], "m³/h", 2),
                _m("Drift", st.drift_m3_h[i], "m³/h", 3),
                _m("Daily rate", makeup * 24, "m³/day", 0),
                _m("Allocation", alloc, "m³/day", 0),
            ],
        )  # fmt: skip
    )
    blow = float(st.blowdown_m3_h[i])
    out.append(
        EquipmentState(
            id="BD-01", tag="BD-01", name="Blowdown outlet", kind="blowdown",
            state="running" if blow > 1e-6 else "off",
            summary=f"{blow:.2f} m³/h at {float(st.coc[i]):.1f} cycles" if blow > 1e-6 else "Closed",
            metrics=[
                _m("Blowdown flow", blow, "m³/h", 2),
                _m("Cycles of concentration", st.coc[i], "", 1),
                _m("Share of makeup", blow / makeup * 100 if makeup > 1e-6 else 0.0, "%", 0),
            ],
        )  # fmt: skip
    )

    # pipe circuits
    circuits = [
        ("PIPE-CWS", "CWS", "Condenser water supply", cws if wet_on else None, cw_flow, wet_on),
        ("PIPE-CWR", "CWR", "Condenser water return", cwr if wet_on else None, cw_flow, wet_on),
        ("PIPE-CHWS", "CHWS", "Chilled water supply", t_chws, chw_flow, True),
        ("PIPE-CHWR", "CHWR", "Chilled water return", t_chwr, chw_flow, True),
    ]
    for cid, tag, name, temp, flow, on in circuits:
        out.append(
            EquipmentState(
                id=cid, tag=tag, name=name, kind="pipe", state="running" if on else "off",
                summary=f"{temp:.1f} °C, {flow:.0f} m³/h" if on and temp is not None else "No flow",
                metrics=[_m("Temperature", temp, "°C", 1), _m("Flow", flow if on else 0.0, "m³/h", 0)],
            )  # fmt: skip
        )
    return out
