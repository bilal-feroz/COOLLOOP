# COOLLOOP

Climate-aware water intelligence and digital twin for hybrid-cooled data centres in hot, arid climates.

COOLLOOP takes a real weather forecast, runs it through a physics model of a data centre cooling plant, and shows an operator how much water and energy the plant will use, where it will be stressed, and which set points would do better. An operator reviews the recommendation and approves it before anything changes.

```
Weather forecast  ->  Physics simulation  ->  Digital twin  ->  Optimisation  ->  Operator approval
(Meteomatics)         (Python, NumPy)         (Three.js)        (SciPy SLSQP)     (always a human)
```

The facility is a **synthetic reference design**. Every plant value in the application is simulated and labelled as such. Nothing is presented as a measurement.

## Quick start

Requirements: Python 3.11 or newer, Node.js 20 or newer.

```bash
# 1. Backend
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt        # Windows
# .venv/bin/pip install -r requirements.txt          # macOS / Linux

# 2. Frontend
cd ../frontend
npm install

# 3. Run both
cd ..
node dev.mjs
```

Open http://localhost:3000. The application opens on the Operations control room.

Without credentials it starts in **demo mode** on a deterministic synthetic weather profile, clearly labelled. To use live weather, and to replay real past heat events, see the next section.

## Meteomatics weather

Copy `.env.example` to `.env` in the repository root and fill in the account:

```
METEOMATICS_USERNAME=...
METEOMATICS_PASSWORD=...
METEOMATICS_BASE_URL=https://api.meteomatics.com
```

The backend notices the saved file by itself; no restart is needed. Credentials are read by the Python backend only. The browser talks to the Next.js server, which proxies `/api` to the backend, so credentials never reach frontend code.

What the weather service does (`backend/app/weather/`):

| Requirement | Implementation |
|---|---|
| Request format | `{base}/{start}--{end}:PT1H/{parameters}/{lat},{lon}/json?source=mix`, HTTP basic auth |
| Coverage | `source=mix`, the global blend. Regional models (EURO1k, US1k) are not used |
| Parameters | `t_2m:C`, `wet_bulb_t_2m:C`, `relative_humidity_2m:p`, `dew_point_2m:C`, `wind_speed_10m:ms`, `global_rad:W`, `precip_1h:mm`, `evaporation_1h:mm`, `sfc_pressure:hPa` |
| Verification | If a combined request is rejected, each parameter is tested on its own. Missing ones are dropped and reported in the UI. Wet-bulb is derived from temperature and humidity when the account lacks it, and labelled "derived" |
| Current, forecast, history | One hourly request for the next 7 days, one for the previous 24 hours (optional: reported if the account does not allow it) |
| Caching | 15 minutes in memory and on disk, so a restart does not spend queries |
| Quota | `user_stats_json` is read every 10 minutes; requests stop before the daily limit. The source panel also shows how far back the account's history goes and when the account expires |
| Failures | Classified (credentials, permission, rate limit, server, timeout, network, format). The last good forecast is served and labelled **cached**. With no cache the status is **unavailable**. Live data is never replaced with synthetic data |
| Location | Abu Dhabi by default; name, coordinates and UTC offset are editable in the top bar |

Every weather payload carries its provider, source model, retrieval time, the API's own generation time, and whether it is live, cached, replayed or synthetic. The top bar shows this at all times.

Environmental evaporation from Meteomatics (`evaporation_1h`, negative means evaporation) is shown for context only. It is never used as cooling tower evaporation.

### Replay: real past weather

A cooling plant is only tested on its worst days, and today is rarely one of them. Replay mode runs the whole product on Meteomatics history instead of the live forecast.

- **Finding the days that matter.** One hourly request covers the past 12 months at the site (8,761 values per parameter). From it the backend picks three hours: the highest wet-bulb, the highest dry-bulb and the driest heat. For Abu Dhabi, scanned in November 2026, the first of these is 13 August 2026 at 19:00, when wet-bulb reached 31.7 °C, 1.7 K above the tower design point.
- **Replaying them.** A chosen hour is replayed from 12 hours earlier, so the event is still ahead and the plant can be prepared for it. Any other date and time can be entered.
- **Walking through an event.** The replayed moment acts as "now": the hours before it are history, the hours after it are what actually followed. It can be moved by 1 or 6 hours, and the twin, the projection and the recommendation follow.
- **Cost.** One request covers every moment of a replayed day, and past weather is kept on disk, so stepping through a replay spends no further queries and works without a connection once loaded. The list of hardest hours is kept too, and stays available if a later scan fails.

A replay is real Meteomatics data, but it is not current and it is not a forecast. A bar across every screen says so, the clock shows the replayed time, and the alerts and the briefing name the period. If a period cannot be retrieved, nothing is simulated and no data is substituted.

## The four screens

**Operations** is the control room: current conditions, the 72-hour forecast, the projected water and cooling power, the cooling stress timeline, alerts, and the latest recommendation, around the live 3D facility.

**Digital twin** is the full 3D model: data hall with 400 racks, five water-cooled chillers, four air-cooled chillers, a five-cell cooling tower, pumps, storage tank, makeup line, blowdown outlet and colour-coded pipe circuits. Everything is procedural geometry, no downloaded assets. Equipment is selectable from the model or the list. Fan speed, flow direction, vapour plumes, tank level and status markers follow the simulation.

**Simulation** is the what-if bench. Sliders for IT load, ambient conditions, set points, tower fan speed, pump speed, cycles of concentration, water availability and the wet/dry split. Every change recalculates. Three scenarios are compared side by side (current, water-saving, balanced) together with the operator's draft.

**Intelligence** is the briefing: three analyst roles (climate, thermal, operations planner) explain the risks, the consumption and the recommendation, each finding with the values it rests on. The recommendation is approved or dismissed here.

## The physics model

`backend/app/physics/`. Steady-state, vectorised with NumPy so a whole forecast is solved in one call (about 2 ms for 72 hours).

**Heat path.** IT load, electrical losses, CRAH fan heat and weather-driven envelope gains make the cooling load. It is split between a wet plant (water-cooled chillers, condenser loop, cooling towers) and a dry plant (air-cooled chillers).

**Cooling tower.** Effectiveness-NTU model of Braun, Klein and Mitchell (1989), the formulation used in the ASHRAE HVAC toolkit and EnergyPlus. The tower is solved on an enthalpy basis, so it responds to wet-bulb, dry-bulb and humidity. The tower and chiller balance is solved for the condenser water temperatures.

**Water balance.**

```
evaporation = latent heat rejection / latent heat of vaporisation
blowdown    = evaporation / (cycles of concentration - 1)
drift       = 0.002 % of circulating flow
makeup      = evaporation + blowdown + drift
```

Cycles of concentration at or below 1 are rejected. The balance closes to machine precision and is tested.

**Energy.** Chiller COP is a fixed fraction of the Carnot COP between the refrigerant temperatures. Tower fans follow the cube of speed; condenser pumps follow an affinity law with static head.

One result worth knowing: in hot, dry air the tower also cools the air passing through it, so it evaporates more water than the heat load alone accounts for. The model shows latent fractions above 1 on dry afternoons. That is why humidity, not only temperature, drives water use in an arid climate.

All assumptions are listed in `backend/app/physics/assumptions.py` and shown in the Intelligence screen. This is a screening model. It is not a validated engineering-grade plant model.

## Optimisation

`backend/app/optimizer.py`. Deterministic, no language model.

```
minimise   w_water * M / M_baseline  +  w_energy * E / E_baseline
over       evaporative share, tower fan speed, condenser pump speed,
           cycles of concentration, chilled-water supply set point
subject to condenser water limits, tower cell loading, chiller and dry-plant
           capacity, condensing limit, server inlet limit, in every forecast
           hour, and the water allocation for the window
```

Solved with SciPy SLSQP from three fixed starting points. The solver first keeps an operating margin from every limit and falls back to the bare limits only when it must. Running with the towers off is checked as a separate option. If nothing is feasible, the result says why: for example the lowest makeup that respects the equipment limits against the allocation.

Water-saving uses weights 0.85 / 0.15, balanced uses 0.5 / 0.5. Both are parameters of the API.

## AI

The briefing in the Intelligence screen is written by fixed rules over verified data. It needs no language model and is always available.

Questions to the analysts are optional and use Claude (`ANTHROPIC_API_KEY` in `.env`). Each analyst is a system prompt plus read-only tools that return the same weather, simulation and optimisation structures the rest of the application uses. The model never calculates engineering values, there is no tool that changes the facility, and every answer lists the data it read. Without a key, or if the API fails, everything else keeps working.

## Tests

```bash
cd backend
.venv\Scripts\python -m pytest
```

101 tests: psychrometrics against reference values, water balance conservation, energy balance of chillers, towers and the whole plant, optimiser feasibility and determinism, the weather client against the documented URL and JSON formats (including failures, caching, quota, parameter fallback, replay and the scan for extreme hours), the API end to end, and the Claude tool loop against a fake endpoint.

## Layout

```
backend/app
  physics/        psychrometrics, plant model, assumptions
  weather/        Meteomatics client, caching service, replay, synthetic demo dataset
  optimizer.py    set-point optimisation and scenario comparison
  projection.py   hourly projection, tank trajectory, high-demand periods
  report.py       constraints, stress index, equipment states
  analysis.py     alerts
  intelligence/   deterministic briefing, optional Claude analysts
  engine.py       application service
  main.py         FastAPI routes
frontend
  components/twin/    procedural 3D model, instancing kit, flow and fan animation
  components/views/   Operations, Digital twin, Simulation, Intelligence
  components/charts.tsx   SVG charts with tooltips, keyboard access, table views
  lib/                typed API client, state, formatting
```

## Limits

- The facility and its baseline telemetry are synthetic.
- The plant model is steady-state and simplified: no thermal storage, no control dynamics, no part-load chiller curves.
- Set points are held constant over the optimisation window.
- Applying a configuration changes the simulation only. COOLLOOP does not control equipment.
