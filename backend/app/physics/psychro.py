"""Moist-air psychrometrics (ASHRAE Handbook - Fundamentals, ch. 1).

Units, used consistently across the physics package:
    temperature        degC      (kelvin only inside the saturation-pressure fit)
    pressure           Pa
    humidity ratio     kg water vapour / kg dry air
    specific enthalpy  kJ / kg dry air
    relative humidity  fraction 0..1

Every function is vectorised with NumPy so a whole forecast horizon is
evaluated in one call.
"""

from __future__ import annotations

import numpy as np

P_STD = 101_325.0  # Pa, standard atmosphere at sea level
CP_DA = 1.006  # kJ/(kg.K), dry air
CP_WV = 1.86  # kJ/(kg.K), water vapour
CP_W = 4.186  # kJ/(kg.K), liquid water
HFG_0 = 2501.0  # kJ/kg, latent heat of vaporisation at 0 degC
EPSILON = 0.621945  # ratio of molar masses, water / dry air
RHO_W = 997.0  # kg/m3, liquid water near 25 degC


def standard_pressure(elevation_m: float) -> float:
    """Barometric pressure of the standard atmosphere at an elevation [Pa]."""
    return P_STD * (1.0 - 2.25577e-5 * elevation_m) ** 5.2559


def saturation_pressure(t_c):
    """Saturation vapour pressure over liquid water [Pa].

    ASHRAE Fundamentals (2017) ch. 1 eq. 6 (Hyland & Wexler), valid 0..200 degC.
    """
    t_k = np.asarray(t_c, dtype=float) + 273.15
    return np.exp(
        -5.8002206e3 / t_k
        + 1.3914993
        - 4.8640239e-2 * t_k
        + 4.1764768e-5 * t_k**2
        - 1.4452093e-8 * t_k**3
        + 6.5459673 * np.log(t_k)
    )


def humidity_ratio(p_w, p=P_STD):
    """Humidity ratio from water-vapour partial pressure."""
    return EPSILON * p_w / (p - p_w)


def saturation_humidity_ratio(t_c, p=P_STD):
    return humidity_ratio(saturation_pressure(t_c), p)


def enthalpy(t_c, w):
    """Specific enthalpy of moist air [kJ/kg dry air]."""
    return CP_DA * t_c + w * (HFG_0 + CP_WV * t_c)


def saturation_enthalpy(t_c, p=P_STD):
    """Enthalpy of saturated air at a temperature [kJ/kg dry air]."""
    return enthalpy(t_c, saturation_humidity_ratio(t_c, p))


def dry_bulb_from_enthalpy(h, w):
    """Invert `enthalpy` for dry-bulb temperature."""
    return (h - HFG_0 * w) / (CP_DA + CP_WV * w)


def humidity_ratio_from_rh(t_c, rh, p=P_STD):
    return humidity_ratio(np.clip(rh, 0.0, 1.0) * saturation_pressure(t_c), p)


def humidity_ratio_from_dew_point(t_dp_c, p=P_STD):
    return saturation_humidity_ratio(t_dp_c, p)


def humidity_ratio_from_wet_bulb(t_db_c, t_wb_c, p=P_STD):
    """ASHRAE Fundamentals ch. 1 eq. 33 (above freezing)."""
    w_s_wb = saturation_humidity_ratio(t_wb_c, p)
    w = ((HFG_0 - 2.326 * t_wb_c) * w_s_wb - CP_DA * (t_db_c - t_wb_c)) / (
        HFG_0 + CP_WV * t_db_c - CP_W * t_wb_c
    )
    return np.maximum(w, 1e-6)


def relative_humidity(t_c, w, p=P_STD):
    p_w = p * w / (EPSILON + w)
    return np.clip(p_w / saturation_pressure(t_c), 0.0, 1.0)


def wet_bulb(t_db_c, w, p=P_STD, iterations: int = 40):
    """Thermodynamic wet-bulb temperature by bisection on ASHRAE eq. 33."""
    t_db = np.asarray(t_db_c, dtype=float)
    w = np.broadcast_to(np.asarray(w, dtype=float), np.broadcast(t_db, w).shape)
    t_db = np.broadcast_to(t_db, w.shape)
    lo = t_db - 60.0
    hi = t_db.copy()
    for _ in range(iterations):
        mid = 0.5 * (lo + hi)
        too_high = humidity_ratio_from_wet_bulb(t_db, mid, p) > w
        hi = np.where(too_high, mid, hi)
        lo = np.where(too_high, lo, mid)
    return 0.5 * (lo + hi)


def temperature_from_saturation_enthalpy(h, p=P_STD, iterations: int = 40):
    """Temperature at which saturated air has enthalpy `h` (bisection)."""
    h = np.asarray(h, dtype=float)
    lo = np.full(h.shape, -20.0)
    hi = np.full(h.shape, 95.0)
    for _ in range(iterations):
        mid = 0.5 * (lo + hi)
        too_high = saturation_enthalpy(mid, p) > h
        hi = np.where(too_high, mid, hi)
        lo = np.where(too_high, lo, mid)
    return 0.5 * (lo + hi)


def latent_heat_of_vaporisation(t_c):
    """Latent heat of vaporisation of water [kJ/kg], linear fit 0..60 degC."""
    return HFG_0 - 2.361 * np.asarray(t_c, dtype=float)
