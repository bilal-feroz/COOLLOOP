"""The LLM layer, exercised against a fake Anthropic endpoint (no network)."""

import json
from datetime import datetime, timezone

import anthropic
import httpx2
import pytest

from app.facility import FACILITY, Location, OperatingConfig
from app.intelligence import agents
from app.optimizer import Window, optimise_scenarios
from app.physics.plant import Controls, simulate
from app.projection import ambient_from_hours, project
from app.report import point_result
from app.schemas import Objective, WeatherBundle
from app.weather import demo


@pytest.fixture(scope="module")
def context() -> agents.Context:
    start = datetime(2026, 8, 3, 6, tzinfo=timezone.utc)
    hours = demo.demo_series(start, 48)
    cfg = OperatingConfig()
    amb = ambient_from_hours(hours, Location())
    times = [h.time for h in hours]
    _, projection = project(FACILITY, cfg, times, amb)
    now = point_result(FACILITY, cfg, simulate(FACILITY, Controls.from_config(cfg), amb), 0, time=times[0])
    window = Window(times[:24], ambient_from_hours(hours[:24], Location()), "forecast")
    optimisation = optimise_scenarios(
        FACILITY, cfg, window, Objective(w_water=0.85, w_energy=0.15), Objective()
    )
    weather = WeatherBundle(
        mode="demo", status="demo", synthetic=True, provider="COOLLOOP synthetic dataset",
        location=Location(), current=hours[0], hourly=hours, wet_bulb_source="synthetic",
    )  # fmt: skip
    return agents.Context(FACILITY, cfg, weather, now, projection, optimisation)


class FakeAnthropic:
    """Replies with one tool call, then a final answer."""

    def __init__(self, tool: str):
        self.tool = tool
        self.requests: list[dict] = []
        self.headers: list[httpx2.Headers] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        self.headers.append(request.headers)
        base = {
            "id": f"msg_{len(self.requests)}", "type": "message", "role": "assistant",
            "model": body["model"], "stop_sequence": None,
            "usage": {"input_tokens": 100, "output_tokens": 20},
        }  # fmt: skip
        if len(self.requests) == 1:
            content = [{"type": "tool_use", "id": "toolu_1", "name": self.tool, "input": {}}]
            return httpx2.Response(200, json={**base, "content": content, "stop_reason": "tool_use"})
        content = [{"type": "text", "text": "Simulated makeup is driven by dry afternoon air."}]
        return httpx2.Response(200, json={**base, "content": content, "stop_reason": "end_turn"})


def client_for(fake) -> anthropic.Anthropic:
    return anthropic.Anthropic(
        api_key="test-key", max_retries=0,
        http_client=anthropic.DefaultHttpxClient(transport=httpx2.MockTransport(fake)),
    )  # fmt: skip


def test_answer_is_built_from_tool_data(context):
    fake = FakeAnthropic("get_operating_point")
    answer = agents.ask("thermal", "Why is water use high?", context, "claude-opus-5-5", client_for(fake))
    assert answer.analyst == "Thermal Analyst" and answer.tools_used == ["get_operating_point"]
    assert "makeup" in answer.answer and answer.model == "claude-opus-5-5"

    first, second = fake.requests
    assert first["model"] == "claude-opus-5-5"
    assert first["fallbacks"] == "default" and first["output_config"] == {"effort": "medium"}
    assert "server-side-fallback-2026-07-01" in fake.headers[0]["anthropic-beta"]
    assert [t["name"] for t in first["tools"]] == list(agents.ROLES["thermal"]["tools"])
    assert "tool_choice" not in first  # forced tool use is not supported on this model
    assert "simulated" in first["system"] and "cannot change the facility" in first["system"]

    # The tool result the model received is the verified simulation output.
    result = second["messages"][-1]["content"][0]
    assert result["type"] == "tool_result" and result["tool_use_id"] == "toolu_1"
    text = result["content"] if isinstance(result["content"], str) else result["content"][0]["text"]
    payload = json.loads(text)
    assert payload["simulated"] is True
    assert payload["water"]["makeup_m3_h"] == context.now.water.makeup_m3_h
    assert payload["energy"]["cooling_power_kw"] == context.now.energy.cooling_power_kw


def test_no_role_has_a_tool_that_changes_the_facility(context):
    tools = agents.build_tools(context, [])
    assert all(name.startswith("get_") for name in tools)
    for role in agents.ROLES.values():
        assert set(role["tools"]) <= set(tools)


def test_tools_return_the_same_numbers_as_the_engine(context):
    used: list[str] = []
    tools = agents.build_tools(context, used)
    optimisation = json.loads(tools["get_optimisation"].call({}))
    assert optimisation["recommended"] == context.optimisation.recommended
    balanced = next(s for s in optimisation["scenarios"] if s["key"] == "balanced")
    expected = next(s for s in context.optimisation.scenarios if s.key == "balanced")
    assert balanced["totals"]["makeup_m3"] == expected.summary.makeup_m3
    assert balanced["set_points"] == expected.config.model_dump()

    weather = json.loads(tools["get_weather_summary"].call({}))
    assert weather["status"] == "demo" and weather["synthetic"] is True
    rows = json.loads(tools["get_hourly_forecast"].call({"hours": 6}))["rows"]
    assert len(rows) == 6 and rows[0]["wet_bulb_c"] == context.weather.hourly[0].wet_bulb_c
    projection = json.loads(tools["get_projection"].call({}))
    assert projection["next_24h"]["makeup_m3"] == context.projection.day.makeup_m3
    assert "peak_makeup_local" in projection["next_24h"]
    assert used == ["get_optimisation", "get_weather_summary", "get_hourly_forecast", "get_projection"]


def test_api_failures_become_llm_unavailable(context):
    def unauthorised(request):
        error = {"type": "error", "error": {"type": "authentication_error", "message": "bad key"}}
        return httpx2.Response(401, json=error)

    with pytest.raises(agents.LlmUnavailable, match="credentials"):
        agents.ask("planner", "What should I do?", context, "claude-opus-5-5", client_for(unauthorised))

    def down(request):
        raise httpx2.ConnectError("offline")

    with pytest.raises(agents.LlmUnavailable, match="reach"):
        agents.ask("climate", "Any risk tonight?", context, "claude-opus-5-5", client_for(down))


def test_refusal_is_reported_plainly(context):
    def refuse(request):
        body = json.loads(request.content)
        return httpx2.Response(200, json={
            "id": "msg_1", "type": "message", "role": "assistant", "model": body["model"],
            "content": [], "stop_reason": "refusal", "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 0},
        })  # fmt: skip

    answer = agents.ask("climate", "Tell me something else", context, "claude-opus-5-5", client_for(refuse))
    assert "declined" in answer.answer and answer.tools_used == []
