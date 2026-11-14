import numpy as np
import pytest

from app.facility import FACILITY as F
from app.facility import OperatingConfig
from app.physics import psychro as ps
from app.physics.plant import (
    Ambient,
    Controls,
    carnot_cop,
    simulate,
    tower_heat_rejection,
    tower_ntu,
    tower_ntu_coefficient,
)
from app.report import point_result


def solve(cfg: OperatingConfig | None = None, **ambient):
    ambient = ambient or {"t_db_c": 40.0, "t_wb_c": 26.0}
    return simulate(F, Controls.from_config(cfg or OperatingConfig()), Ambient(**ambient))


def grid(n=300):
    rng = np.random.default_rng(11)
    t_db = rng.uniform(12.0, 50.0, n)
    ctl = Controls(
        it_load_kw=rng.uniform(2_400.0, 12_000.0, n),
        chw_supply_c=rng.uniform(10.0, 22.0, n),
        tower_fan_speed=rng.uniform(0.35, 1.0, n),
        cw_pump_speed=rng.uniform(0.5, 1.0, n),
        cycles_of_concentration=rng.uniform(2.0, 10.0, n),
        wet_fraction=rng.uniform(0.2, 1.0, n),
        tower_cells_online=rng.integers(3, 6, n),
    )
    return simulate(F, ctl, Ambient(t_db_c=t_db, t_wb_c=t_db - rng.uniform(0.5, 20.0, n)))


def test_chillers_obey_the_first_law():
    st = grid()
    assert st.q_rej_wet_kw == pytest.approx(st.q_wet_kw + st.wc_comp_kw)
    assert st.q_rej_dry_kw == pytest.approx(st.q_dry_kw + st.dry_comp_kw)


def test_plant_rejects_cooling_load_plus_compressor_work():
    st = grid()
    assert st.heat_rejection_kw == pytest.approx(st.q_cool_kw + st.wc_comp_kw + st.dry_comp_kw)
    assert st.q_wet_kw + st.q_dry_kw == pytest.approx(st.q_cool_kw)


def test_tower_water_side_matches_heat_rejection():
    st = grid()
    ok = st.tower_solved
    water_side = st.cw_flow_kg_s * ps.CP_W * st.range_k
    assert water_side[ok] == pytest.approx(st.q_rej_wet_kw[ok], rel=1e-9)


def test_tower_air_side_matches_heat_rejection():
    st = grid()
    ok = st.tower_solved
    h_out = ps.enthalpy(st.t_air_out_c, st.w_out)
    air_side = st.air_flow_kg_s * (h_out - st.h_in)
    assert air_side[ok] == pytest.approx(st.q_rej_wet_kw[ok], rel=1e-9)


def test_tower_and_chiller_balance_is_solved_tightly():
    st = grid()
    ok = st.tower_solved
    m_a = F.tower_design_cell_air_kg_s * st.fan_speed
    m_w = st.cw_flow_kg_s / st.cells_online
    ntu = tower_ntu(m_a, m_w, tower_ntu_coefficient(F), F.tower_ntu_exponent)
    q_cell, _ = tower_heat_rejection(m_a, m_w, st.t_cwr_c, st.t_cws_c, st.h_in, st.pressure_pa, ntu)
    assert (st.cells_online * q_cell)[ok] == pytest.approx(st.q_rej_wet_kw[ok], rel=1e-6)


def test_tower_is_calibrated_to_its_design_point():
    w_in = ps.humidity_ratio_from_wet_bulb(F.tower_design_dry_bulb_c, F.tower_design_wet_bulb_c)
    h_in = ps.enthalpy(F.tower_design_dry_bulb_c, w_in)
    m_a, m_w = F.tower_design_cell_air_kg_s, F.tower_design_cell_water_kg_s
    ntu = tower_ntu(m_a, m_w, tower_ntu_coefficient(F), F.tower_ntu_exponent)
    t_out = F.tower_design_wet_bulb_c + F.tower_design_approach_k
    q, eff = tower_heat_rejection(m_a, m_w, t_out + F.tower_design_range_k, t_out, h_in, ps.P_STD, ntu)
    assert float(q) == pytest.approx(F.tower_design_rejection_kw, rel=1e-4)
    assert 0.0 < float(eff) < 1.0


def test_design_day_reproduces_design_approach_and_range():
    st = solve(OperatingConfig(it_load_kw=12_000.0), t_db_c=36.0, t_wb_c=30.0)
    assert st.approach_k[0] == pytest.approx(F.tower_design_approach_k, abs=0.15)
    assert st.range_k[0] == pytest.approx(F.tower_design_range_k, abs=0.15)


def test_condenser_water_tracks_wet_bulb():
    cool = solve(t_db_c=34.0, t_wb_c=22.0)
    humid = solve(t_db_c=34.0, t_wb_c=30.0)
    assert humid.t_cws_c[0] > cool.t_cws_c[0] + 5.0
    assert humid.wc_cop[0] < cool.wc_cop[0]
    assert np.all(grid().approach_k[grid().tower_solved] > 0.0)


def test_slower_fans_raise_condenser_water_and_cut_fan_power():
    fast = solve(OperatingConfig(tower_fan_speed=1.0))
    slow = solve(OperatingConfig(tower_fan_speed=0.5))
    assert slow.t_cws_c[0] > fast.t_cws_c[0]
    assert slow.wc_comp_kw[0] > fast.wc_comp_kw[0]
    assert slow.tower_fan_kw[0] == pytest.approx(fast.tower_fan_kw[0] / 8.0)


def test_fan_and_pump_power_laws():
    st = solve(OperatingConfig(tower_fan_speed=0.8, cw_pump_speed=0.7, tower_cells_online=5))
    assert st.tower_fan_kw[0] == pytest.approx(5 * F.tower_fan_design_kw * 0.8**3)
    s, h = 0.7, F.cw_static_head_fraction
    assert st.cw_pump_kw[0] == pytest.approx(F.cw_pump_design_kw * (h * s + (1 - h) * s**3))


def test_cop_is_bounded_by_carnot_and_falls_with_lift():
    st = grid()
    t_e = st.chw_supply_c - F.evaporator_approach_k + 273.15
    t_c = st.t_cwr_c + F.condenser_approach_k + 273.15
    lift = t_c - t_e
    working = lift > F.chiller_min_lift_k
    assert np.all(st.wc_cop[working] < (t_e / lift)[working])
    # Head-pressure control bounds the COP when the tower water is very cold.
    assert np.all(st.wc_cop <= F.wc_carnot_efficiency * t_e / F.chiller_min_lift_k + 1e-9)
    assert float(carnot_cop(0.68, 14.0, 45.0)) < float(carnot_cop(0.68, 14.0, 35.0))


def test_dry_plant_costs_more_energy_per_unit_of_cooling():
    wet = solve(OperatingConfig(wet_fraction=1.0), t_db_c=42.0, t_wb_c=25.0)
    hybrid = solve(OperatingConfig(wet_fraction=0.6), t_db_c=42.0, t_wb_c=25.0)
    assert hybrid.cooling_power_kw[0] > wet.cooling_power_kw[0]
    assert hybrid.makeup_kg_s[0] < wet.makeup_kg_s[0]
    assert hybrid.dry_cop[0] < hybrid.wc_cop[0]


def test_cooling_power_is_the_sum_of_its_parts():
    st = grid()
    parts = (
        st.wc_comp_kw + st.dry_comp_kw + st.tower_fan_kw + st.cw_pump_kw
        + st.chw_pump_kw + st.dry_fan_kw + st.crah_fan_kw
    )  # fmt: skip
    assert st.cooling_power_kw == pytest.approx(parts)
    assert st.ppue == pytest.approx((st.it_kw + st.cooling_power_kw) / st.it_kw)


def test_weather_changes_the_cooling_load():
    mild = solve(t_db_c=24.0, t_wb_c=18.0, ghi_w_m2=0.0)
    harsh = solve(t_db_c=46.0, t_wb_c=28.0, ghi_w_m2=950.0)
    assert harsh.q_cool_kw[0] > mild.q_cool_kw[0] + 50.0


def test_vectorised_solution_matches_point_by_point():
    t_db = np.array([28.0, 36.0, 45.0])
    t_wb = np.array([21.0, 30.0, 24.0])
    cfg = OperatingConfig(wet_fraction=0.8, tower_fan_speed=0.7)
    batch = simulate(F, Controls.from_config(cfg), Ambient(t_db_c=t_db, t_wb_c=t_wb))
    for k in range(3):
        single = solve(cfg, t_db_c=float(t_db[k]), t_wb_c=float(t_wb[k]))
        assert batch.t_cws_c[k] == pytest.approx(single.t_cws_c[0], abs=1e-9)
        assert batch.makeup_kg_s[k] == pytest.approx(single.makeup_kg_s[0], rel=1e-9)
        assert batch.cooling_power_kw[k] == pytest.approx(single.cooling_power_kw[0], rel=1e-9)


def test_undersized_towers_are_flagged_not_hidden():
    cfg = OperatingConfig(tower_cells_online=3, tower_fan_speed=0.5)
    result = point_result(F, cfg, solve(cfg, t_db_c=34.0, t_wb_c=30.0))
    by_id = {c.id: c for c in result.constraints}
    assert by_id["cws_high"].status == "violated"
    assert not result.feasible
    assert any("Condenser water supply" in w for w in result.warnings)
    assert result.stress.level == "critical"


def test_point_result_structure():
    cfg = OperatingConfig()
    result = point_result(F, cfg, solve(cfg))
    assert result.simulated and result.feasible
    assert result.energy.ppue == pytest.approx(1 + result.energy.cooling_power_kw / cfg.it_load_kw, abs=1e-3)
    assert result.capacity.margin_kw > 0
    kinds = {e.kind for e in result.equipment}
    assert {"hall", "wc_chiller", "ac_chiller", "tower", "cw_pump", "chw_pump", "tank", "makeup", "blowdown", "pipe"} <= kinds
    towers = [e for e in result.equipment if e.kind == "tower"]
    assert [e.state for e in towers] == ["running"] * 4 + ["standby"]
