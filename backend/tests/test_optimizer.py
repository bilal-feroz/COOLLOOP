from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from app.facility import FACILITY as F
from app.facility import AmbientOverride, Location, OperatingConfig
from app.optimizer import (
    HYBRID_MIN_WET_FRACTION,
    Window,
    constraint_vector,
    optimise_scenarios,
    tradeoff_curve,
)
from app.physics.plant import Controls, simulate
from app.projection import ambient_from_hours, ambient_from_override
from app.schemas import Objective
from app.weather import demo

WATER = Objective(w_water=0.85, w_energy=0.15)
BALANCED = Objective(w_water=0.5, w_energy=0.5)
START = datetime(2026, 8, 3, 6, tzinfo=timezone.utc)


def window(hours=24, start=START, override=None) -> Window:
    if override is not None:
        times = [start + timedelta(hours=k) for k in range(hours)]
        return Window(times, ambient_from_override(override, Location(), hours), "manual")
    weather = demo.demo_series(start, hours)
    return Window([h.time for h in weather], ambient_from_hours(weather, Location()), "forecast")


def solve(base=None, **kwargs):
    return optimise_scenarios(F, base or OperatingConfig(), window(**kwargs), WATER, BALANCED)


@pytest.fixture(scope="module")
def result():
    return solve()


def by_key(res):
    return {s.key: s for s in res.scenarios}


def test_three_scenarios_are_returned_and_compared(result):
    s = by_key(result)
    assert list(s) == ["baseline", "water_saving", "balanced"]
    assert s["baseline"].deltas is None and s["baseline"].solver.status == "baseline"
    for key in ("water_saving", "balanced"):
        assert s[key].feasible and s[key].solver.status == "optimal"
        assert s[key].deltas is not None and s[key].changes
        assert len(s[key].hourly_makeup_m3_h) == 24


def test_optimised_scenarios_respect_every_constraint(result):
    w = window()
    for scenario in result.scenarios[1:]:
        assert all(c.status in ("ok", "n/a") for c in scenario.constraints), scenario.constraints
        st = simulate(F, Controls.from_config(scenario.config), w.ambient)
        # Operating margins (tier 1) are kept in every hour, not just the limits.
        assert (constraint_vector(F, scenario.config, st, 1.0) >= -1e-9).all()
        assert st.tower_solved.all()


def test_set_points_stay_inside_equipment_operating_ranges(result):
    for scenario in result.scenarios[1:]:
        c = scenario.config
        assert F.tower_fan_speed_min <= c.tower_fan_speed <= 1.0
        assert F.cw_pump_speed_min <= c.cw_pump_speed <= 1.0
        assert F.coc_min <= c.cycles_of_concentration <= F.coc_max
        assert F.chw_supply_min_c <= c.chw_supply_c <= F.chw_supply_max_c
        assert c.wet_fraction == 0.0 or HYBRID_MIN_WET_FRACTION <= c.wet_fraction <= 1.0


def test_objectives_improve_on_the_baseline(result):
    s = by_key(result)
    assert s["baseline"].objective.value == pytest.approx(1.0)
    assert s["balanced"].objective.value < 0.95
    assert s["water_saving"].objective.value < 0.95
    # More weight on water buys less water at the price of more energy.
    assert s["water_saving"].summary.makeup_m3 < s["balanced"].summary.makeup_m3
    assert s["water_saving"].summary.cooling_energy_kwh > s["balanced"].summary.cooling_energy_kwh
    assert s["water_saving"].deltas.makeup_pct < -30.0


def test_objective_is_the_weighted_normalised_sum(result):
    for scenario in result.scenarios:
        o = scenario.objective
        assert o.value == pytest.approx(o.w_water * o.water_term + o.w_energy * o.energy_term, abs=1e-4)
    balanced = by_key(result)["balanced"]
    base = by_key(result)["baseline"].summary
    assert balanced.objective.water_term == pytest.approx(balanced.summary.makeup_m3 / base.makeup_m3, abs=1e-3)


def test_optimisation_is_deterministic(result):
    again = solve()
    for a, b in zip(result.scenarios, again.scenarios):
        assert a.config == b.config
        assert a.summary.makeup_m3 == b.summary.makeup_m3


def test_weather_changes_the_answer():
    humid = by_key(solve(start=START + timedelta(days=2)))
    dry = by_key(solve(start=START + timedelta(days=4)))
    assert humid["baseline"].summary.makeup_m3 != pytest.approx(dry["baseline"].summary.makeup_m3, rel=0.02)
    assert humid["water_saving"].config != dry["water_saving"].config


def test_tight_water_allocation_forces_a_drier_strategy():
    res = solve(OperatingConfig(water_allocation_m3_day=330.0))
    s = by_key(res)
    assert not s["baseline"].feasible
    assert any("Makeup water" in m for m in s["baseline"].infeasibility)
    assert s["balanced"].feasible and s["balanced"].summary.makeup_m3 <= 330.0
    assert res.recommended in ("balanced", "water_saving")
    assert "breaks a limit" in res.recommendation_reason


def test_impossible_allocation_is_explained_not_faked():
    res = solve(OperatingConfig(water_allocation_m3_day=120.0))
    s = by_key(res)
    assert not s["water_saving"].feasible and s["water_saving"].solver.status == "infeasible"
    reason = s["water_saving"].infeasibility[0]
    assert "cannot be met" in reason and "lowest makeup" in reason and "120 m³" in reason
    assert res.recommended == "baseline" and "No feasible configuration" in res.recommendation_reason


def test_all_dry_mode_is_used_when_the_dry_plant_can_carry_the_load():
    s = by_key(solve(OperatingConfig(it_load_kw=4_000.0)))
    assert s["water_saving"].config.wet_fraction == 0.0
    assert s["water_saving"].summary.makeup_m3 == 0.0
    assert s["water_saving"].feasible


def test_manual_ambient_window_is_supported():
    res = solve(override=AmbientOverride(t_db_c=29.0, rh_pct=55.0))
    assert res.ambient_source == "manual"
    assert by_key(res)["balanced"].feasible


def test_tradeoff_curve_runs_from_dry_to_wet(result):
    curve = result.tradeoff
    assert curve[0].wet_fraction == 0.0 and curve[-1].wet_fraction == 1.0
    assert curve[0].makeup_m3 == 0.0
    makeup = np.array([p.makeup_m3 for p in curve])
    energy = np.array([p.energy_kwh for p in curve])
    feasible = np.array([p.feasible for p in curve])
    assert feasible.any()
    assert makeup[feasible][-1] > makeup[feasible][0]
    assert energy[feasible][-1] < energy[feasible][0]
    assert len(tradeoff_curve(F, OperatingConfig(), window(), BALANCED, points=5)) == 5
