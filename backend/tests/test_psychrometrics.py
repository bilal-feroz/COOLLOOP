import numpy as np
import pytest

from app.physics import psychro as ps
from app.physics.plant import _sat_enthalpy, _t_from_sat_enthalpy


def test_saturation_pressure_matches_steam_tables():
    assert float(ps.saturation_pressure(20.0)) == pytest.approx(2339.0, abs=3.0)
    assert float(ps.saturation_pressure(30.0)) == pytest.approx(4246.0, abs=4.0)
    assert float(ps.saturation_pressure(100.0)) == pytest.approx(101_325.0, rel=2e-3)


def test_saturated_air_enthalpy_at_30c():
    # ASHRAE moist-air table: about 100 kJ/kg dry air at 30 degC, sea level.
    assert float(ps.saturation_enthalpy(30.0)) == pytest.approx(100.0, abs=0.5)


def test_known_wet_bulb_point():
    w = ps.humidity_ratio_from_rh(35.0, 0.40)
    assert float(ps.wet_bulb(np.array([35.0]), w)[0]) == pytest.approx(24.0, abs=0.2)


def test_wet_bulb_round_trip():
    t_db = np.array([20.0, 30.0, 38.0, 46.0])
    t_wb = np.array([14.0, 22.0, 29.5, 24.0])
    w = ps.humidity_ratio_from_wet_bulb(t_db, t_wb)
    assert ps.wet_bulb(t_db, w) == pytest.approx(t_wb, abs=1e-6)


def test_saturated_air_has_equal_dry_bulb_wet_bulb_and_dew_point():
    t = np.array([15.0, 28.0, 33.0])
    w = ps.humidity_ratio_from_rh(t, 1.0)
    assert ps.wet_bulb(t, w) == pytest.approx(t, abs=1e-6)
    assert ps.humidity_ratio_from_dew_point(t) == pytest.approx(w)


def test_wet_bulb_never_exceeds_dry_bulb():
    t_db = np.linspace(5.0, 50.0, 40)
    for rh in (0.05, 0.3, 0.7, 1.0):
        t_wb = ps.wet_bulb(t_db, ps.humidity_ratio_from_rh(t_db, rh))
        assert np.all(t_wb <= t_db + 1e-9)


def test_relative_humidity_round_trip():
    t = np.array([10.0, 25.0, 44.0])
    rh = np.array([0.2, 0.55, 0.9])
    assert ps.relative_humidity(t, ps.humidity_ratio_from_rh(t, rh)) == pytest.approx(rh)


def test_enthalpy_inverse():
    t, w = 31.5, 0.018
    assert float(ps.dry_bulb_from_enthalpy(ps.enthalpy(t, w), w)) == pytest.approx(t)
    h = ps.saturation_enthalpy(np.array([12.0, 27.0, 41.0]))
    assert ps.temperature_from_saturation_enthalpy(h) == pytest.approx([12.0, 27.0, 41.0], abs=1e-6)


def test_fast_tables_agree_with_reference_formulas():
    t = np.linspace(5.0, 70.0, 200)
    for p in (95_000.0, ps.P_STD):
        assert _sat_enthalpy(t, p) == pytest.approx(ps.saturation_enthalpy(t, p), rel=1e-6)
        assert _t_from_sat_enthalpy(ps.saturation_enthalpy(t, p), p) == pytest.approx(t, abs=1e-5)


def test_standard_pressure_falls_with_elevation():
    assert ps.standard_pressure(0.0) == pytest.approx(101_325.0)
    assert ps.standard_pressure(1000.0) == pytest.approx(89_875.0, rel=2e-3)
