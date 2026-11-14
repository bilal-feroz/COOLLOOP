"""Steady-state energy and water balance of the hybrid cooling plant.

Heat path
    IT load -> CRAH -> chilled water -> chillers -> heat rejection
    The cooling load is split between
      * a WET plant: water-cooled chillers -> condenser water -> cooling towers
      * a DRY plant: air-cooled chillers rejecting straight to ambient air

Tower model
    Effectiveness-NTU cooling tower model of Braun, Klein & Mitchell (1989),
    the formulation used by the ASHRAE HVAC toolkit and EnergyPlus. The tower
    is treated as a counterflow exchanger on an enthalpy basis with the Merkel
    assumptions (Lewis number 1, water loss neglected in the energy balance).

Water balance
    evaporation = latent heat rejection / latent heat of vaporisation
    blowdown    = evaporation / (cycles of concentration - 1)
    drift       = drift fraction x circulating flow
    makeup      = evaporation + blowdown + drift

Everything is vectorised: pass arrays for the ambient conditions to evaluate a
whole forecast horizon in one call. This is a simplified screening model, not
a validated plant model.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import numpy as np

from ..facility import Facility, OperatingConfig
from . import psychro as ps

M3H_PER_KGS = 3600.0 / ps.RHO_W
NOT_APPLICABLE = 99.0  # margin reported for limits that do not apply (plant off)

# The solver evaluates saturation properties thousands of times per request, so
# it interpolates the ASHRAE saturation-pressure fit on a 0.02 K grid instead of
# re-evaluating it (relative error below 1e-6).
_T_GRID = np.linspace(-40.0, 120.0, 8001)
_PWS_GRID = ps.saturation_pressure(_T_GRID)
_T_INV_GRID = _T_GRID[:6501]  # -40..90 degC
_HS_STD_GRID = ps.saturation_enthalpy(_T_INV_GRID, ps.P_STD)


def _sat_humidity_ratio(t_c, p):
    p_ws = np.interp(t_c, _T_GRID, _PWS_GRID)
    return ps.EPSILON * p_ws / (p - p_ws)


def _sat_enthalpy(t_c, p):
    return ps.CP_DA * t_c + _sat_humidity_ratio(t_c, p) * (ps.HFG_0 + ps.CP_WV * t_c)


def _sat_enthalpy_pair(t_a, t_b, p):
    """Saturation enthalpy at two temperatures with a single table lookup."""
    hs = _sat_enthalpy(np.stack((t_a, t_b)), p)
    return hs[0], hs[1]


def _t_from_sat_enthalpy(h, p):
    """Temperature of saturated air with enthalpy `h`: table guess at standard
    pressure, then three Newton steps at the actual pressure."""
    t = np.interp(h, _HS_STD_GRID, _T_INV_GRID)
    for _ in range(3):
        f0 = _sat_enthalpy(t, p)
        slope = (_sat_enthalpy(t + 0.01, p) - f0) / 0.01
        t = t - (f0 - h) / slope
    return t


def _illinois(f, a, fa, b, fb, iterations: int):
    """Illinois regula falsi on a bracket [a, b] with f(a) < 0 <= f(b)."""
    for _ in range(iterations):
        denom = fb - fa
        ok = np.abs(denom) > 1e-12
        c = np.where(ok, b - fb * (b - a) / np.where(ok, denom, 1.0), 0.5 * (a + b))
        fc = f(c)
        cross = fc * fb < 0.0
        a = np.where(cross, b, a)
        fa = np.where(cross, fb, 0.5 * fa)
        b, fb = c, fc
    return b


def _solve_bracketed(f, lo, hi, guess=None, bisections: int = 4, secants: int = 6):
    """Vectorised root of a monotonic increasing residual on [lo, hi].

    A few bisections shrink the bracket, then Illinois regula falsi converges
    super-linearly. Returns (root, solvable). Elements whose residual is still
    negative at `hi` are unsolvable and return `hi`; elements already
    non-negative at `lo` return `lo`.

    `guess` is an optional previous solution. When the root of every element
    lies within 0.4 K of it, the search starts from that narrow bracket, which
    is what makes the optimiser's finite-difference steps cheap.
    """
    if guess is not None and guess.shape == np.shape(lo):
        a, b = guess - 0.4, guess + 0.4
        fa, fb = f(a), f(b)
        if np.all((fa < 0.0) & (fb >= 0.0)):
            return _illinois(f, a, fa, b, fb, 4), np.ones(guess.shape, dtype=bool)
    lo0, hi0 = lo, hi
    f_lo = f(lo)
    f_hi = f(hi)
    solvable = f_hi >= 0.0
    at_floor = f_lo >= 0.0
    for _ in range(bisections):
        mid = 0.5 * (lo + hi)
        f_mid = f(mid)
        neg = f_mid < 0.0
        lo = np.where(neg, mid, lo)
        f_lo = np.where(neg, f_mid, f_lo)
        hi = np.where(neg, hi, mid)
        f_hi = np.where(neg, f_hi, f_mid)
    root = np.where(solvable, _illinois(f, lo, f_lo, hi, f_hi, secants), hi0)
    return np.where(at_floor, lo0, root), solvable


@dataclass
class Controls:
    """Operating set points; scalars or arrays that broadcast with the ambient."""

    it_load_kw: Any
    chw_supply_c: Any
    tower_fan_speed: Any
    cw_pump_speed: Any
    cycles_of_concentration: Any
    wet_fraction: Any
    tower_cells_online: Any

    @classmethod
    def from_config(cls, cfg: OperatingConfig) -> "Controls":
        return cls(
            it_load_kw=cfg.it_load_kw,
            chw_supply_c=cfg.chw_supply_c,
            tower_fan_speed=cfg.tower_fan_speed,
            cw_pump_speed=cfg.cw_pump_speed,
            cycles_of_concentration=cfg.cycles_of_concentration,
            wet_fraction=cfg.wet_fraction,
            tower_cells_online=cfg.tower_cells_online,
        )


@dataclass
class Ambient:
    """Outdoor air. Give `t_wb_c` (preferred) or `rh` (fraction 0..1)."""

    t_db_c: Any
    t_wb_c: Any = None
    rh: Any = None
    pressure_pa: Any = ps.P_STD
    wind_ms: Any = 3.0
    ghi_w_m2: Any = 0.0


@dataclass
class PlantState:
    """Solved plant state. Every field is an array of the broadcast shape."""

    # ambient
    t_db_c: np.ndarray
    t_wb_c: np.ndarray
    rh: np.ndarray
    w_in: np.ndarray
    h_in: np.ndarray
    pressure_pa: np.ndarray
    # loads [kW]
    it_kw: np.ndarray
    q_env_kw: np.ndarray
    q_cool_kw: np.ndarray
    q_wet_kw: np.ndarray
    q_dry_kw: np.ndarray
    server_inlet_c: np.ndarray
    chw_supply_c: np.ndarray
    # dry plant
    dry_capacity_kw: np.ndarray
    dry_plr: np.ndarray
    dry_t_cond_c: np.ndarray
    dry_cop: np.ndarray
    dry_comp_kw: np.ndarray
    dry_fan_kw: np.ndarray
    q_rej_dry_kw: np.ndarray
    # wet plant
    wet_on: np.ndarray
    wc_cop: np.ndarray
    wc_comp_kw: np.ndarray
    q_rej_wet_kw: np.ndarray
    cw_flow_kg_s: np.ndarray
    air_flow_kg_s: np.ndarray
    cells_online: np.ndarray
    t_cws_c: np.ndarray
    t_cwr_c: np.ndarray
    range_k: np.ndarray
    approach_k: np.ndarray
    ntu: np.ndarray
    effectiveness: np.ndarray
    tower_solved: np.ndarray
    t_air_out_c: np.ndarray
    w_out: np.ndarray
    q_latent_kw: np.ndarray
    q_sensible_kw: np.ndarray
    h_fg_kj_kg: np.ndarray
    # water [kg/s]
    evaporation_kg_s: np.ndarray
    blowdown_kg_s: np.ndarray
    drift_kg_s: np.ndarray
    makeup_kg_s: np.ndarray
    coc: np.ndarray
    # power [kW]
    tower_fan_kw: np.ndarray
    cw_pump_kw: np.ndarray
    chw_pump_kw: np.ndarray
    crah_fan_kw: np.ndarray
    cooling_power_kw: np.ndarray
    # controls echoed for reporting
    fan_speed: np.ndarray
    pump_speed: np.ndarray
    wet_fraction: np.ndarray
    # constraint margins (>= 0 means satisfied), see `MARGIN_KEYS`
    margins: dict[str, np.ndarray]

    @property
    def makeup_m3_h(self) -> np.ndarray:
        return self.makeup_kg_s * M3H_PER_KGS

    @property
    def evaporation_m3_h(self) -> np.ndarray:
        return self.evaporation_kg_s * M3H_PER_KGS

    @property
    def blowdown_m3_h(self) -> np.ndarray:
        return self.blowdown_kg_s * M3H_PER_KGS

    @property
    def drift_m3_h(self) -> np.ndarray:
        return self.drift_kg_s * M3H_PER_KGS

    @property
    def heat_rejection_kw(self) -> np.ndarray:
        return self.q_rej_wet_kw + self.q_rej_dry_kw

    @property
    def ppue(self) -> np.ndarray:
        return (self.it_kw + self.cooling_power_kw) / self.it_kw

    @property
    def wue_l_kwh(self) -> np.ndarray:
        return self.makeup_m3_h * 1000.0 / self.it_kw


MARGIN_KEYS = (
    "cws_high",  # K below the condenser entering-water limit
    "cws_low",  # K above the minimum condenser entering-water temperature
    "cw_range",  # K below the maximum condenser range
    "cell_flow_low",  # tower cell water flow above its minimum wetting rate
    "cell_flow_high",  # tower cell water flow below its hydraulic maximum
    "wc_chiller_capacity",  # fraction of installed water-cooled capacity left
    "dry_capacity",  # fraction of rated dry capacity left after ambient derate
    "dry_condensing",  # K below the air-cooled condensing limit
    "server_inlet",  # K below the server inlet limit
)


def carnot_cop(second_law_efficiency, t_evap_c, t_cond_c, min_lift_k: float = 12.0):
    """Chiller COP as a fixed fraction of the Carnot COP between the
    refrigerant evaporating and condensing temperatures. Head-pressure control
    keeps the compressor lift at or above `min_lift_k`, which bounds the COP."""
    t_e = np.asarray(t_evap_c, dtype=float) + 273.15
    t_c = np.asarray(t_cond_c, dtype=float) + 273.15
    return second_law_efficiency * t_e / np.maximum(t_c - t_e, min_lift_k)


def tower_ntu(m_air, m_water, ntu_c, ntu_n):
    """Number of transfer units of a cell: NTU = c (m_water / m_air)^(1+n)."""
    return ntu_c * (m_water / m_air) ** (1.0 + ntu_n)


def tower_heat_rejection(m_air, m_water, t_w_in, t_w_out, h_air_in, p, ntu):
    """Heat rejected by one tower cell [kW] (Braun effectiveness model).

    m_air, m_water in kg/s; temperatures in degC; h_air_in in kJ/kg dry air.
    Returns (q_kw, air_side_effectiveness).
    """
    d_t = np.maximum(t_w_in - t_w_out, 0.05)
    hs_in, hs_out = _sat_enthalpy_pair(t_w_in, t_w_in - d_t, p)
    c_s = (hs_in - hs_out) / d_t  # saturation specific heat, kJ/(kg.K)
    m_star = m_air * c_s / (m_water * ps.CP_W)
    one_minus = 1.0 - m_star
    x = np.exp(np.clip(-ntu * one_minus, -50.0, 50.0))
    balanced = np.abs(one_minus) < 1e-6
    safe = np.where(balanced, 1.0, 1.0 - m_star * x)
    eff = np.where(balanced, ntu / (1.0 + ntu), (1.0 - x) / safe)
    return eff * m_air * (hs_in - h_air_in), eff


@lru_cache(maxsize=16)
def _ntu_coefficient(q_cell, m_w, m_a, t_wb, t_db, approach, rng, n) -> float:
    p = ps.P_STD
    w_in = float(ps.humidity_ratio_from_wet_bulb(t_db, t_wb, p))
    h_in = float(ps.enthalpy(t_db, w_in))
    t_out = t_wb + approach
    t_in = t_out + rng
    hs_in = float(ps.saturation_enthalpy(t_in, p))
    hs_out = float(ps.saturation_enthalpy(t_out, p))
    m_star = m_a * (hs_in - hs_out) / rng / (m_w * ps.CP_W)
    eff = q_cell / (m_a * (hs_in - h_in))
    if not 0.0 < eff < 1.0 or eff * m_star >= 1.0:
        raise ValueError("Tower design point is not thermodynamically achievable")
    if abs(1.0 - m_star) < 1e-9:
        ntu = eff / (1.0 - eff)
    else:
        ntu = -np.log((1.0 - eff) / (1.0 - eff * m_star)) / (1.0 - m_star)
    return float(ntu / (m_w / m_a) ** (1.0 + n))


def tower_ntu_coefficient(fac: Facility) -> float:
    """Calibrate NTU = c (m_w / m_a)^(1+n) so a cell meets its design point."""
    return _ntu_coefficient(
        fac.tower_design_rejection_kw,
        fac.tower_design_cell_water_kg_s,
        fac.tower_design_cell_air_kg_s,
        fac.tower_design_wet_bulb_c,
        fac.tower_design_dry_bulb_c,
        fac.tower_design_approach_k,
        fac.tower_design_range_k,
        fac.tower_ntu_exponent,
    )


def simulate(fac: Facility, ctl: Controls, amb: Ambient, guess: np.ndarray | None = None) -> PlantState:
    """Solve the plant for the given set points and ambient conditions.

    `guess` may carry the condenser return temperatures of a nearby solution
    (see `_solve_bracketed`); it changes the cost of the solve, not the result.
    """
    if amb.t_wb_c is None and amb.rh is None:
        raise ValueError("Ambient needs a wet-bulb temperature or a relative humidity")

    has_wb = amb.t_wb_c is not None
    moisture = amb.t_wb_c if has_wb else amb.rh
    raw = (
        amb.t_db_c, moisture, amb.pressure_pa, amb.wind_ms, amb.ghi_w_m2,
        ctl.it_load_kw, ctl.chw_supply_c, ctl.tower_fan_speed, ctl.cw_pump_speed,
        ctl.cycles_of_concentration, ctl.wet_fraction, ctl.tower_cells_online,
    )  # fmt: skip
    arrays = np.broadcast_arrays(*(np.atleast_1d(np.asarray(v, dtype=float)) for v in raw))
    (t_db, moist, p, wind, ghi, it, t_chws, s_fan, s_pump, coc, phi, n_cells) = arrays

    if np.any(coc <= 1.0):
        raise ValueError("Cycles of concentration must be greater than 1")
    if np.any(it <= 0.0):
        raise ValueError("IT load must be positive")

    # --- ambient moist air ---------------------------------------------------
    if has_wb:
        t_wb = np.minimum(moist, t_db)
        w_in = ps.humidity_ratio_from_wet_bulb(t_db, t_wb, p)
        rh = ps.relative_humidity(t_db, w_in, p)
    else:
        rh = np.clip(moist, 0.01, 1.0)
        w_in = ps.humidity_ratio_from_rh(t_db, rh, p)
        t_wb = ps.wet_bulb(t_db, w_in, p)
    h_in = ps.enthalpy(t_db, w_in)

    # --- cooling load --------------------------------------------------------
    load_ratio = it / fac.it_design_kw
    crah_kw = fac.crah_fan_design_kw * np.clip(load_ratio, fac.crah_min_speed, 1.0) ** 3
    film = 5.7 + 3.8 * np.maximum(wind, 0.0)  # W/(m2.K), external surface film
    t_sol_air = t_db + fac.roof_absorptance * np.maximum(ghi, 0.0) / film
    q_roof = fac.roof_u_w_m2k * fac.roof_area_m2 * (t_sol_air - fac.room_setpoint_c) / 1e3
    q_wall = fac.wall_u_w_m2k * fac.wall_area_m2 * (t_db - fac.room_setpoint_c) / 1e3
    w_room = ps.humidity_ratio_from_rh(fac.room_setpoint_c, fac.room_rh, p)
    q_vent = fac.ventilation_kg_s * (h_in - ps.enthalpy(fac.room_setpoint_c, w_room))
    q_env = q_roof + q_wall + q_vent
    q_cool = it * (1.0 + fac.electrical_loss_fraction) + crah_kw + q_env
    server_inlet = t_chws + fac.crah_approach_design_k * (0.4 + 0.6 * load_ratio)

    q_wet = phi * q_cool
    q_dry = q_cool - q_wet
    t_evap = t_chws - fac.evaporator_approach_k

    # --- dry plant: air-cooled chillers ---------------------------------------
    derate = np.clip(1.0 - fac.ac_derate_per_k * (t_db - fac.ac_rating_ambient_c), 0.55, 1.10)
    dry_cap = fac.dry_capacity_rated_kw * derate
    dry_plr = q_dry / dry_cap
    t_cond_dry = t_db + fac.ac_condenser_approach_design_k * (
        0.35 + 0.65 * np.clip(dry_plr, 0.0, 1.5)
    )
    dry_cop = carnot_cop(fac.ac_carnot_efficiency, t_evap, t_cond_dry, fac.chiller_min_lift_k)
    dry_comp = q_dry / dry_cop
    dry_fan = fac.ac_chiller_count * fac.ac_fan_design_kw * np.clip(dry_plr, 0.0, 1.2)

    # --- wet plant: chillers + condenser loop + towers -------------------------
    wet_on = q_wet > 1.0
    m_cw = fac.cw_flow_design_kg_s * s_pump
    m_w_cell = m_cw / n_cells
    m_a_cell = fac.tower_design_cell_air_kg_s * s_fan
    ntu = tower_ntu(m_a_cell, m_w_cell, tower_ntu_coefficient(fac), fac.tower_ntu_exponent)
    cw_capacity_rate = m_cw * ps.CP_W  # kW/K
    eta_wc = fac.wc_carnot_efficiency
    t_evap_k = t_evap + 273.15
    cond_offset = fac.condenser_approach_k + 273.15
    min_lift = fac.chiller_min_lift_k

    def balance(t_cwr):
        cop = eta_wc * t_evap_k / np.maximum(t_cwr + cond_offset - t_evap_k, min_lift)
        q_rej = q_wet * (1.0 + 1.0 / cop)
        rng = q_rej / cw_capacity_rate
        q_cell, eff = tower_heat_rejection(m_a_cell, m_w_cell, t_cwr, t_cwr - rng, h_in, p, ntu)
        return n_cells * q_cell - q_rej, cop, q_rej, rng, eff

    # Towers must reject exactly what the chillers send them. The residual is
    # monotonic in the return temperature, so one bracketed solve covers every
    # hour of the horizon at once.
    t_cwr, tower_solved = _solve_bracketed(
        lambda t: balance(t)[0], t_wb - 1.0, t_wb + 45.0, guess=guess
    )
    _, wc_cop, q_rej_wet, rng, eff = balance(t_cwr)
    t_cws = t_cwr - rng
    q_rej_wet = np.where(wet_on, q_rej_wet, 0.0)
    wc_comp = np.where(wet_on, q_wet / wc_cop, 0.0)

    # --- tower leaving-air state and evaporation -------------------------------
    h_out = h_in + (q_rej_wet / n_cells) / m_a_cell
    carry = np.exp(-ntu)
    h_surface = h_in + (h_out - h_in) / (1.0 - carry)
    w_sat = _sat_humidity_ratio(_t_from_sat_enthalpy(np.stack((h_surface, h_out)), p), p)
    w_surface, w_sat_out = w_sat[0], w_sat[1]
    w_out = w_surface + (w_in - w_surface) * carry
    # Leaving air cannot hold more vapour than saturation at its own enthalpy.
    w_out = np.clip(w_out, w_in, w_sat_out)
    t_air_out = ps.dry_bulb_from_enthalpy(h_out, w_out)

    h_fg = ps.latent_heat_of_vaporisation(0.5 * (t_cws + t_cwr))
    q_latent = np.where(wet_on, n_cells * m_a_cell * (w_out - w_in) * h_fg, 0.0)
    q_sensible = q_rej_wet - q_latent

    # --- water balance ---------------------------------------------------------
    evaporation = q_latent / h_fg  # kg/s
    blowdown = evaporation / (coc - 1.0)
    drift = np.where(wet_on, fac.drift_fraction * m_cw, 0.0)
    makeup = evaporation + blowdown + drift

    # --- electrical power --------------------------------------------------------
    static = fac.cw_static_head_fraction
    tower_fan = np.where(wet_on, n_cells * fac.tower_fan_design_kw * s_fan**3, 0.0)
    cw_pump = np.where(
        wet_on, fac.cw_pump_design_kw * (static * s_pump + (1.0 - static) * s_pump**3), 0.0
    )
    chw_pump = fac.chw_pump_design_kw * np.clip(q_cool / fac.cooling_load_design_kw, 0.35, 1.2) ** 3
    cooling_power = wc_comp + dry_comp + tower_fan + cw_pump + chw_pump + dry_fan + crah_kw

    # --- constraint margins ------------------------------------------------------
    wc_installed = fac.wc_chiller_count * fac.wc_chiller_capacity_kw
    cell_flow = m_w_cell / fac.tower_design_cell_water_kg_s  # fraction of design wetting
    margins = {
        "cws_high": np.where(wet_on, fac.cws_max_c - t_cws, NOT_APPLICABLE),
        "cws_low": np.where(wet_on, t_cws - fac.cws_min_c, NOT_APPLICABLE),
        "cw_range": np.where(wet_on, fac.cw_range_max_k - rng, NOT_APPLICABLE),
        "cell_flow_low": np.where(wet_on, cell_flow - fac.tower_cell_flow_min, NOT_APPLICABLE),
        "cell_flow_high": np.where(wet_on, fac.tower_cell_flow_max - cell_flow, NOT_APPLICABLE),
        "wc_chiller_capacity": (wc_installed - q_wet) / wc_installed,
        "dry_capacity": (dry_cap - q_dry) / fac.dry_capacity_rated_kw,
        "dry_condensing": np.where(
            q_dry > 1.0, fac.ac_condensing_limit_c - t_cond_dry, NOT_APPLICABLE
        ),
        "server_inlet": fac.server_inlet_limit_c - server_inlet,
    }

    return PlantState(
        t_db_c=t_db, t_wb_c=t_wb, rh=rh, w_in=w_in, h_in=h_in, pressure_pa=p,
        it_kw=it, q_env_kw=q_env, q_cool_kw=q_cool, q_wet_kw=q_wet, q_dry_kw=q_dry,
        server_inlet_c=server_inlet, chw_supply_c=t_chws,
        dry_capacity_kw=dry_cap, dry_plr=dry_plr, dry_t_cond_c=t_cond_dry, dry_cop=dry_cop,
        dry_comp_kw=dry_comp, dry_fan_kw=dry_fan, q_rej_dry_kw=q_dry + dry_comp,
        wet_on=wet_on, wc_cop=wc_cop, wc_comp_kw=wc_comp, q_rej_wet_kw=q_rej_wet,
        cw_flow_kg_s=np.where(wet_on, m_cw, 0.0),
        air_flow_kg_s=np.where(wet_on, n_cells * m_a_cell, 0.0),
        cells_online=n_cells, t_cws_c=t_cws, t_cwr_c=t_cwr, range_k=rng,
        approach_k=t_cws - t_wb, ntu=ntu, effectiveness=eff, tower_solved=tower_solved,
        t_air_out_c=t_air_out, w_out=w_out, q_latent_kw=q_latent, q_sensible_kw=q_sensible,
        h_fg_kj_kg=h_fg, evaporation_kg_s=evaporation, blowdown_kg_s=blowdown,
        drift_kg_s=drift, makeup_kg_s=makeup, coc=coc,
        tower_fan_kw=tower_fan, cw_pump_kw=cw_pump, chw_pump_kw=chw_pump,
        crah_fan_kw=crah_kw, cooling_power_kw=cooling_power,
        fan_speed=s_fan, pump_speed=s_pump, wet_fraction=phi, margins=margins,
    )  # fmt: skip


def tower_rejection_capacity(fac: Facility, state: PlantState) -> np.ndarray:
    """Heat the towers can reject [kW] before condenser-water supply reaches
    its limit (or the range reaches its maximum), at the current ambient, fan
    speed, pump speed and cells online."""
    n_cells = state.cells_online
    m_cw = fac.cw_flow_design_kg_s * state.pump_speed
    m_w_cell = m_cw / n_cells
    m_a_cell = fac.tower_design_cell_air_kg_s * state.fan_speed
    ntu = tower_ntu(m_a_cell, m_w_cell, tower_ntu_coefficient(fac), fac.tower_ntu_exponent)
    t_out = np.full(state.t_wb_c.shape, fac.cws_max_c)

    def deficit(rng):
        q_cell, _ = tower_heat_rejection(
            m_a_cell, m_w_cell, t_out + rng, t_out, state.h_in, state.pressure_pa, ntu
        )
        return m_cw * ps.CP_W * rng - n_cells * q_cell

    lo = np.zeros(t_out.shape)
    hi = np.full(t_out.shape, fac.cw_range_max_k)
    rng, bounded = _solve_bracketed(deficit, lo, hi)
    rng = np.where(bounded, rng, fac.cw_range_max_k)
    return np.maximum(m_cw * ps.CP_W * rng, 0.0)


def wet_cooling_capacity(fac: Facility, state: PlantState) -> tuple[np.ndarray, np.ndarray]:
    """(cooling capacity of the wet plant, tower heat-rejection capacity) in kW."""
    rejection = tower_rejection_capacity(fac, state)
    m_cw = fac.cw_flow_design_kg_s * state.pump_speed
    t_cwr_limit = fac.cws_max_c + rejection / (m_cw * ps.CP_W)
    cop = carnot_cop(
        fac.wc_carnot_efficiency,
        state.chw_supply_c - fac.evaporator_approach_k,
        t_cwr_limit + fac.condenser_approach_k,
        fac.chiller_min_lift_k,
    )
    tower_limited = rejection / (1.0 + 1.0 / cop)
    installed = fac.wc_chiller_count * fac.wc_chiller_capacity_kw
    return np.minimum(tower_limited, installed), rejection
