"""End-to-end API tests on the synthetic demo dataset (no network)."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.engine import Engine
from app.facility import OperatingConfig
from app.main import app, get_engine


@pytest.fixture()
def api(tmp_path, monkeypatch):
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    engine = Engine(Settings(data_dir=tmp_path))  # no Meteomatics credentials -> demo mode
    app.dependency_overrides[get_engine] = lambda: engine
    yield TestClient(app)
    app.dependency_overrides.clear()


def draft(**changes) -> dict:
    return OperatingConfig().model_copy(update=changes).model_dump()


def test_overview_opens_on_labelled_demo_data(api):
    body = api.get("/api/overview").json()
    assert body["weather"]["status"] == "demo" and body["weather"]["synthetic"] is True
    assert body["facility"]["synthetic"] is True and "simulated" in body["facility"]["notice"]
    assert body["now"]["simulated"] is True and body["now"]["water"]["makeup_m3_h"] > 0
    assert len(body["projection"]["times"]) == 72
    assert any(a["id"] == "weather-demo" for a in body["alerts"])
    assert {c["key"] for c in body["controls"]} == set(OperatingConfig.model_fields)
    assert body["assumptions"] and body["llm"]["available"] is False


def test_every_parameter_change_recalculates(api):
    base = api.post("/api/simulate", json={"config": draft()}).json()
    cases = {
        "it_load_kw": 11_000.0, "chw_supply_c": 19.0, "tower_fan_speed": 0.6, "cw_pump_speed": 0.7,
        "cycles_of_concentration": 6.0, "wet_fraction": 0.7, "tower_cells_online": 5,
    }  # fmt: skip
    for key, value in cases.items():
        changed = api.post("/api/simulate", json={"config": draft(**{key: value})}).json()
        before = (base["now"]["water"]["makeup_m3_h"], base["now"]["energy"]["cooling_power_kw"])
        after = (changed["now"]["water"]["makeup_m3_h"], changed["now"]["energy"]["cooling_power_kw"])
        assert before != after, key
    tighter = api.post("/api/simulate", json={"config": draft(water_allocation_m3_day=300.0)}).json()
    assert tighter["now"]["water"]["allocation_utilisation"] > base["now"]["water"]["allocation_utilisation"]


def test_weather_drives_the_simulation(api):
    def run(t, rh):
        return api.post("/api/simulate", json={"config": draft(), "ambient": {"t_db_c": t, "rh_pct": rh}}).json()

    mild, hot_dry, humid = run(26, 50), run(46, 12), run(34, 80)
    assert hot_dry["ambient_source"] == "manual"
    assert hot_dry["now"]["water"]["evaporation_m3_h"] > 1.2 * mild["now"]["water"]["evaporation_m3_h"]
    assert humid["now"]["thermal"]["cws_c"] > mild["now"]["thermal"]["cws_c"] + 3
    assert hot_dry["now"]["thermal"]["cooling_load_kw"] > mild["now"]["thermal"]["cooling_load_kw"]
    assert hot_dry["now"]["conditions"]["source"] == "manual"


def test_simulation_reports_a_closed_water_balance_and_a_draft_comparison(api):
    body = api.post("/api/simulate", json={"config": draft(wet_fraction=0.6, cycles_of_concentration=6)}).json()
    w = body["now"]["water"]
    assert abs(w["makeup_m3_h"] - (w["evaporation_m3_h"] + w["blowdown_m3_h"] + w["drift_m3_h"])) < 1e-3
    assert w["balance_residual_m3_h"] == 0
    d = body["draft"]
    assert d["key"] == "draft" and d["deltas"]["makeup_pct"] < 0
    assert {c["key"] for c in d["changes"]} == {"wet_fraction", "cycles_of_concentration"}
    assert len(d["hourly_makeup_m3_h"]) == 24 and len(body["projection"]["times"]) == 72


def test_three_scenarios_are_compared_and_cached(api):
    first = api.post("/api/optimize", json={}).json()
    assert [s["key"] for s in first["scenarios"]] == ["baseline", "water_saving", "balanced"]
    assert first["recommended"] in ("baseline", "water_saving", "balanced")
    assert all(s["feasible"] for s in first["scenarios"][1:])
    again = api.post("/api/optimize", json={}).json()
    assert again["generated_at"] == first["generated_at"]  # served from the cache
    heavier = api.post("/api/optimize", json={"config": draft(it_load_kw=12_000.0)}).json()
    assert heavier["scenarios"][0]["summary"]["makeup_m3"] > first["scenarios"][0]["summary"]["makeup_m3"]


def test_applying_a_configuration_requires_human_approval(api):
    cfg = api.post("/api/optimize", json={}).json()["scenarios"][2]["config"]
    refused = api.post("/api/config/apply", json={"config": cfg, "source": "optimiser: balanced"})
    assert refused.status_code == 403
    assert api.get("/api/overview").json()["config"] == OperatingConfig().model_dump()

    applied = api.post(
        "/api/config/apply",
        json={"config": cfg, "source": "optimiser: balanced", "approved_by": "Shift lead", "confirm": True},
    )
    assert applied.status_code == 200
    body = applied.json()
    assert body["config"] == cfg and body["config_meta"]["approved_by"] == "Shift lead"
    log = api.get("/api/intelligence").json()["audit"]
    assert log[0]["action"] == "applied" and log[0]["changes"]

    assert api.post("/api/config/reset", json={}).status_code == 403
    reset = api.post("/api/config/reset", json={"confirm": True}).json()
    assert reset["config"] == OperatingConfig().model_dump()


def test_invalid_input_is_rejected(api):
    assert api.post("/api/simulate", json={"config": draft() | {"cycles_of_concentration": 1.0}}).status_code == 422
    assert api.post("/api/simulate", json={"config": draft() | {"tower_fan_speed": 1.4}}).status_code == 422
    assert api.post("/api/optimize", json={"window_hours": 500}).status_code == 422


def test_live_mode_without_credentials_fails_honestly_but_stays_usable(api):
    body = api.put("/api/settings", json={"weather_mode": "live"}).json()
    assert body["weather"]["status"] == "not_configured" and body["weather"]["synthetic"] is False
    assert body["weather"]["hourly"] == [] and body["now"] is None and body["projection"] is None
    assert body["alerts"][0]["severity"] == "critical"
    assert api.post("/api/simulate", json={"config": draft()}).status_code == 409
    assert api.post("/api/optimize", json={}).status_code == 409
    manual = api.post("/api/simulate", json={"config": draft(), "ambient": {"t_db_c": 40, "rh_pct": 30}})
    assert manual.status_code == 200
    assert api.get("/api/intelligence").json()["recommendation"] is None
    back = api.put("/api/settings", json={"weather_mode": "demo"}).json()
    assert back["weather"]["status"] == "demo" and back["now"] is not None


def test_replay_settings_are_validated(api):
    assert api.put("/api/settings", json={"weather_mode": "replay"}).status_code == 400
    future = api.put("/api/settings", json={"weather_mode": "replay", "replay_at": "2999-01-01T00:00:00Z"})
    assert future.status_code == 400 and "past" in future.json()["detail"]
    assert api.get("/api/overview").json()["weather"]["status"] == "demo"  # nothing was switched
    # Without credentials a replay cannot run, and it does not fall back to made-up data.
    body = api.put("/api/settings", json={"weather_mode": "replay", "replay_at": "2026-08-13T03:00:00Z"}).json()
    assert body["weather"]["mode"] == "replay" and body["weather"]["status"] == "not_configured"
    assert body["weather"]["hourly"] == [] and body["now"] is None
    assert api.get("/api/weather/extremes").status_code == 409


def test_site_coordinates_are_configurable(api):
    body = api.put(
        "/api/settings",
        json={"location": {"name": "Riyadh, KSA", "lat": 24.7136, "lon": 46.6753, "utc_offset_hours": 3}},
    ).json()
    assert body["weather"]["location"]["name"] == "Riyadh, KSA"
    assert api.get("/api/overview").json()["weather"]["location"]["lon"] == 46.6753


def test_briefing_uses_the_actual_results(api):
    optimisation = api.post("/api/optimize", json={}).json()
    overview = api.get("/api/overview").json()
    briefing = api.get("/api/intelligence").json()
    assert [s["role"] for s in briefing["sections"]] == ["climate", "thermal", "planner"]
    assert briefing["basis"]["weather_synthetic"] is True
    rec = briefing["recommendation"]
    chosen = next(s for s in optimisation["scenarios"] if s["key"] == optimisation["recommended"])
    assert rec["scenario_key"] == optimisation["recommended"] and rec["config"] == chosen["config"]
    assert rec["deltas"] == chosen["deltas"] and "operator approves" in rec["approval_note"]
    makeup = overview["now"]["water"]["makeup_m3_h"]
    assert f"{makeup:.1f}" in briefing["sections"][1]["findings"][0]["detail"]
    assert all(f["detail"] for s in briefing["sections"] for f in s["findings"])


def test_product_works_without_an_llm(api):
    response = api.post("/api/intelligence/ask", json={"role": "thermal", "question": "Why is water use high?"})
    assert response.status_code == 503
    assert "credentials" in response.json()["detail"]
    assert api.get("/api/intelligence").status_code == 200
