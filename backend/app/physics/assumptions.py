"""Model assumptions, exposed verbatim through the API and the UI."""

from __future__ import annotations

ASSUMPTIONS: list[dict[str, str]] = [
    {
        "id": "scope",
        "area": "Scope",
        "text": (
            "Steady-state screening model of a synthetic reference facility. Every value is "
            "simulated, none is measured, and the model is not a validated engineering-grade "
            "plant model."
        ),
    },
    {
        "id": "tower",
        "area": "Cooling tower",
        "text": (
            "Counterflow cells solved with the Braun effectiveness-NTU method on an enthalpy "
            "basis (Merkel assumptions: Lewis number 1, water loss neglected in the energy "
            "balance). NTU = c (L/G)^(1+n) with n = -0.6 and c calibrated to the design point: "
            "30 degC wet-bulb, 4 K approach, 5.5 K range, L/G 1.3."
        ),
        "reference": "Braun, Klein & Mitchell (1989), ASHRAE Transactions 95(2)",
    },
    {
        "id": "evaporation",
        "area": "Water balance",
        "text": (
            "Evaporation = latent heat rejection / latent heat of vaporisation. Latent heat is "
            "the moisture gained by the tower air stream times h_fg at the mean tower water "
            "temperature, so it responds to both dry-bulb and humidity."
        ),
    },
    {
        "id": "blowdown",
        "area": "Water balance",
        "text": (
            "Blowdown = evaporation / (cycles of concentration - 1). Drift is neglected in the "
            "dissolved-solids balance because it is far smaller than blowdown."
        ),
    },
    {
        "id": "drift",
        "area": "Water balance",
        "text": "Drift = 0.002 % of the circulating condenser-water flow (modern eliminators).",
    },
    {
        "id": "makeup",
        "area": "Water balance",
        "text": "Makeup = evaporation + blowdown + drift. Rain is not credited as makeup.",
    },
    {
        "id": "chillers",
        "area": "Chillers",
        "text": (
            "COP = constant second-law efficiency x Carnot COP between refrigerant temperatures "
            "(leaving water temperatures with a 2.5 K approach). Water-cooled 0.68, air-cooled "
            "0.50. Lift never drops below 12 K (head-pressure control). No part-load or "
            "staging curve."
        ),
    },
    {
        "id": "dry_plant",
        "area": "Dry plant",
        "text": (
            "Air-cooled condensing temperature = dry-bulb + 16 K x (0.35 + 0.65 x part-load "
            "ratio). Capacity derates 1.2 % per K above 35 degC ambient."
        ),
    },
    {
        "id": "fans_pumps",
        "area": "Fans and pumps",
        "text": (
            "Tower air flow is proportional to fan speed and fan power to its cube. Condenser "
            "pump power = design x (0.30 s + 0.70 s^3), a 30 % static head. Chilled-water pump "
            "and CRAH fan power follow the cube of the load ratio."
        ),
    },
    {
        "id": "load",
        "area": "Cooling load",
        "text": (
            "Cooling load = IT load x 1.03 (electrical losses) + CRAH fan heat + weather-driven "
            "gains: sol-air roof conduction, wall conduction and fresh-air enthalpy."
        ),
    },
    {
        "id": "server_inlet",
        "area": "White space",
        "text": "Server inlet = chilled-water supply + 6 K x (0.4 + 0.6 x IT load ratio).",
    },
    {
        "id": "psychrometrics",
        "area": "Air properties",
        "text": (
            "Moist-air properties follow ASHRAE Fundamentals ch. 1 (Hyland-Wexler saturation "
            "pressure)."
        ),
        "reference": "ASHRAE Handbook - Fundamentals (2017), chapter 1",
    },
    {
        "id": "horizon",
        "area": "Projection",
        "text": (
            "The projection holds the set points constant for every forecast hour and treats "
            "each hour as a steady state. Thermal storage and control dynamics are not modelled."
        ),
    },
    {
        "id": "tank",
        "area": "Water supply",
        "text": (
            "Tank level integrates makeup demand against the daily allocation, assumed to be "
            "delivered at a uniform hourly rate."
        ),
    },
    {
        "id": "environmental_evaporation",
        "area": "Weather",
        "text": (
            "Meteomatics evaporation_1h is surface evaporation from the weather model. It is "
            "shown for context only and never used as cooling-tower evaporation."
        ),
    },
]
