import numpy as np
import pytest
from pydantic import ValidationError

from app.facility import FACILITY as F
from app.facility import OperatingConfig
from app.physics.plant import Ambient, Controls, simulate
from app.report import point_result


def solve(cfg: OperatingConfig | None = None, **ambient):
    ambient = ambient or {"t_db_c": 40.0, "t_wb_c": 26.0}
    return simulate(F, Controls.from_config(cfg or OperatingConfig()), Ambient(**ambient))


def grid():
    """A broad sweep of ambient conditions and set points, solved in one call."""
    rng = np.random.default_rng(7)
    n = 400
    t_db = rng.uniform(12.0, 50.0, n)
    ctl = Controls(
        it_load_kw=rng.uniform(2_400.0, 12_000.0, n),
        chw_supply_c=rng.uniform(10.0, 22.0, n),
        tower_fan_speed=rng.uniform(0.25, 1.0, n),
        cw_pump_speed=rng.uniform(0.45, 1.0, n),
        cycles_of_concentration=rng.uniform(2.0, 10.0, n),
        wet_fraction=rng.uniform(0.0, 1.0, n),
        tower_cells_online=rng.integers(1, 6, n),
    )
    amb = Ambient(t_db_c=t_db, t_wb_c=t_db - rng.uniform(0.5, 22.0, n))
    return simulate(F, ctl, amb)


def test_makeup_equals_evaporation_plus_blowdown_plus_drift():
    st = grid()
    assert st.makeup_kg_s == pytest.approx(st.evaporation_kg_s + st.blowdown_kg_s + st.drift_kg_s, abs=1e-12)
    assert np.all(st.evaporation_kg_s >= 0.0)
    assert np.all(st.blowdown_kg_s >= 0.0)
    assert np.all(st.drift_kg_s >= 0.0)


def test_blowdown_follows_cycles_of_concentration():
    st = grid()
    assert st.blowdown_kg_s == pytest.approx(st.evaporation_kg_s / (st.coc - 1.0))
    # Dissolved-solids balance (drift neglected): what enters with the makeup
    # leaves with the blowdown at COC times the makeup concentration.
    wet = st.blowdown_kg_s > 1e-9
    assert ((st.evaporation_kg_s + st.blowdown_kg_s) / st.blowdown_kg_s)[wet] == pytest.approx(st.coc[wet])


def test_evaporation_is_latent_heat_over_latent_heat_of_vaporisation():
    st = grid()
    assert st.evaporation_kg_s * st.h_fg_kj_kg == pytest.approx(st.q_latent_kw)
    assert st.q_latent_kw + st.q_sensible_kw == pytest.approx(st.q_rej_wet_kw)


def test_evaporation_matches_air_side_moisture_gain():
    st = grid()
    assert st.evaporation_kg_s == pytest.approx(st.air_flow_kg_s * (st.w_out - st.w_in), abs=1e-9)


def test_cycles_of_concentration_must_exceed_one():
    with pytest.raises(ValidationError):
        OperatingConfig(cycles_of_concentration=1.0)
    with pytest.raises(ValidationError):
        OperatingConfig(cycles_of_concentration=0.5)
    controls = Controls.from_config(OperatingConfig())
    controls.cycles_of_concentration = 1.0
    with pytest.raises(ValueError, match="greater than 1"):
        simulate(F, controls, Ambient(t_db_c=35.0, t_wb_c=25.0))


def test_higher_cycles_cut_blowdown_but_not_evaporation():
    low = solve(OperatingConfig(cycles_of_concentration=3.0))
    high = solve(OperatingConfig(cycles_of_concentration=6.0))
    assert high.evaporation_kg_s == pytest.approx(low.evaporation_kg_s)
    assert high.blowdown_kg_s[0] == pytest.approx(low.blowdown_kg_s[0] * (3.0 - 1.0) / (6.0 - 1.0))
    assert high.makeup_kg_s[0] < low.makeup_kg_s[0]


def test_design_point_evaporation_is_about_one_percent_of_flow():
    # Rule of thumb: ~0.85 % of circulating flow per 5.5 K of range.
    st = solve(OperatingConfig(it_load_kw=12_000.0), t_db_c=36.0, t_wb_c=30.0)
    share = float(st.evaporation_kg_s[0] / st.cw_flow_kg_s[0])
    assert 0.006 < share < 0.011


def test_hot_dry_air_evaporates_more_than_humid_air_for_the_same_wet_bulb():
    humid = solve(t_db_c=30.0, t_wb_c=27.0)
    arid = solve(t_db_c=46.0, t_wb_c=27.0)
    assert arid.evaporation_kg_s[0] > 1.15 * humid.evaporation_kg_s[0]
    # In hot, dry air the tower also cools the air stream: latent > total.
    assert arid.q_latent_kw[0] > arid.q_rej_wet_kw[0]


def test_dry_operation_uses_no_water():
    st = solve(OperatingConfig(wet_fraction=0.0, it_load_kw=4_000.0))
    assert st.makeup_kg_s[0] == 0.0
    assert st.evaporation_kg_s[0] == 0.0
    assert st.tower_fan_kw[0] == 0.0 and st.cw_pump_kw[0] == 0.0


def test_water_use_falls_with_wet_share():
    full = solve(OperatingConfig(wet_fraction=1.0))
    half = solve(OperatingConfig(wet_fraction=0.5))
    # Less than proportional at a fixed fan speed: in hot, dry air the towers
    # keep evaporating to cool the air stream even when lightly loaded.
    assert 0.45 < half.makeup_kg_s[0] / full.makeup_kg_s[0] < 0.85


def test_over_ventilated_towers_waste_water_in_hot_dry_air():
    fast = solve(OperatingConfig(tower_fan_speed=1.0), t_db_c=46.0, t_wb_c=24.0)
    slow = solve(OperatingConfig(tower_fan_speed=0.6), t_db_c=46.0, t_wb_c=24.0)
    assert slow.evaporation_kg_s[0] < fast.evaporation_kg_s[0]


def test_drift_is_a_fixed_share_of_circulating_flow():
    st = solve(OperatingConfig(cw_pump_speed=0.6))
    assert st.drift_kg_s[0] == pytest.approx(F.drift_fraction * F.cw_flow_design_kg_s * 0.6)


def test_point_result_reports_a_closed_balance():
    cfg = OperatingConfig()
    result = point_result(F, cfg, solve(cfg))
    w = result.water
    assert w.balance_residual_m3_h == pytest.approx(0.0, abs=1e-9)
    assert w.makeup_m3_h == pytest.approx(w.evaporation_m3_h + w.blowdown_m3_h + w.drift_m3_h, abs=1e-3)
    assert w.makeup_m3_day == pytest.approx(w.makeup_m3_h * 24.0, abs=0.1)
    assert w.wue_l_kwh == pytest.approx(w.makeup_m3_h * 1000.0 / cfg.it_load_kw, abs=1e-3)
