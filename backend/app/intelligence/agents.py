"""Optional natural-language answers from Claude.

Three logical roles share one small loop: a role is a system prompt plus the
read-only tools it may call. The model sees plant and weather data only
through those tools, which return the same verified structures the rest of
the application uses. There is no tool that changes the facility, so an
answer can recommend a configuration but can never apply one.

If no credentials are configured, or the API fails, the caller gets
`LlmUnavailable` and the application keeps working on the deterministic
briefing.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

import anthropic
from anthropic import beta_tool
from pydantic import BaseModel

from ..facility import Facility, OperatingConfig
from ..physics.assumptions import ASSUMPTIONS
from ..schemas import OptimizationResult, PointResult, Projection, WeatherBundle

Role = Literal["climate", "thermal", "planner"]

ROLES: dict[str, dict] = {
    "climate": {
        "name": "Climate Analyst",
        "remit": (
            "You interpret the weather forecast for the site and explain what it means for "
            "cooling: wet-bulb against the tower design point, dry-bulb against the dry plant, "
            "dry air and evaporation, and when the difficult hours are."
        ),
        "tools": ("get_weather_summary", "get_hourly_forecast", "get_projection"),
    },
    "thermal": {
        "name": "Thermal Analyst",
        "remit": (
            "You explain the simulated plant: where the water goes (evaporation, blowdown, "
            "drift), what drives consumption up or down, where the cooling energy goes, and how "
            "much thermal headroom is left."
        ),
        "tools": ("get_operating_point", "get_projection", "get_weather_summary", "get_facility_and_assumptions"),
    },
    "planner": {
        "name": "Operations Planner",
        "remit": (
            "You explain the optimisation result: which configuration is recommended and why, "
            "what each set-point change does, what it costs in water or energy, and which "
            "constraints bind. You help the operator decide; you do not decide for them."
        ),
        "tools": ("get_optimisation", "get_operating_point", "get_projection", "get_facility_and_assumptions"),
    },
}

_SYSTEM = """You are the {name} in COOLLOOP, an operations tool for a hybrid-cooled data centre in a hot, arid climate. The person asking is a plant operator.

{remit}

How to work:
- Call your tools before answering anything about the plant, the weather or the optimisation. Every figure you give must be one a tool returned in this conversation. If the tools do not hold the figure, say it is not available; do not estimate, extrapolate or recompute engineering values yourself, because the operator will act on them.
- The facility is a synthetic reference design and every plant value is simulated. Say "simulated" or "projected", never "measured", and never describe projected savings as achieved.
- The weather has a status: live, cached, or demo. Demo weather is synthetic and cached weather is stale. Mention the status when it affects how far the answer can be trusted.
- You cannot change the facility and have no tool that does. A configuration is applied only when an operator approves it in the interface. You may say which configuration you would put forward for approval, and why.

How to answer: lead with the answer in one sentence, then the two or three numbers that support it, with units and the hour they refer to. Plain prose, no headings. Keep it under 150 words unless the operator asks for more depth."""


class LlmStatus(BaseModel):
    available: bool
    provider: str = "Anthropic"
    model: str
    detail: str


class Answer(BaseModel):
    role: Role
    analyst: str
    question: str
    answer: str
    tools_used: list[str]
    model: str
    generated_at: datetime


class LlmUnavailable(Exception):
    pass


@dataclass
class Context:
    """Verified data an answer may draw on. Built by the engine per request."""

    facility: Facility
    config: OperatingConfig
    weather: WeatherBundle
    now: PointResult | None
    projection: Projection | None
    optimisation: OptimizationResult | None


def credentials_present() -> bool:
    """True when the Anthropic SDK has something to authenticate with: an API
    key, an auth token, or a profile written by `ant auth login`."""
    if os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN") or os.getenv("ANTHROPIC_PROFILE"):
        return True
    return (Path.home() / ".config" / "anthropic").is_dir()


def status(model: str) -> LlmStatus:
    if credentials_present():
        return LlmStatus(available=True, model=model, detail="Answers are generated from tool data only.")
    return LlmStatus(
        available=False, model=model,
        detail="No Anthropic credentials configured. The deterministic briefing is unaffected.",
    )  # fmt: skip


def _dump(data) -> str:
    return json.dumps(data, default=str, separators=(",", ":"))


def _local(t: datetime | None, offset_hours: float) -> str | None:
    if t is None:
        return None
    return (t.astimezone(timezone.utc) + timedelta(hours=offset_hours)).strftime("%a %d %b %H:%M")


def build_tools(ctx: Context, used: list[str]) -> dict:
    """Read-only tools over the request's data snapshot."""
    offset = ctx.weather.location.utc_offset_hours

    def note(name: str) -> None:
        if name not in used:
            used.append(name)

    @beta_tool
    def get_weather_summary() -> str:
        """Weather source, status and timestamps, current conditions and forecast extremes for the site."""
        note("get_weather_summary")
        w = ctx.weather
        out: dict = {
            "status": w.status, "synthetic": w.synthetic, "provider": w.provider, "model": w.model,
            "site": w.location.name, "local_time_utc_offset_h": offset,
            "fetched_at_utc": w.fetched_at, "last_success_utc": w.last_success_at,
            "wet_bulb_source": w.wet_bulb_source, "notice": w.notice,
            "error": w.error.message if w.error else None,
            "parameters": {p.id: p.source for p in w.parameters},
        }  # fmt: skip
        if w.current:
            out["current"] = {"valid_local": _local(w.current.time, offset), **w.current.model_dump(exclude={"time"})}
        if w.hourly:
            hours = w.hourly[:72]

            def extreme(field: str, pick):
                rows = [h for h in hours if getattr(h, field) is not None]
                if not rows:
                    return None
                best = pick(rows, key=lambda h: getattr(h, field))
                return {"value": getattr(best, field), "local": _local(best.time, offset)}

            out["next_72h"] = {
                "max_dry_bulb_c": extreme("t_2m_c", max), "min_dry_bulb_c": extreme("t_2m_c", min),
                "max_wet_bulb_c": extreme("wet_bulb_c", max), "min_rh_pct": extreme("rh_pct", min),
                "max_rh_pct": extreme("rh_pct", max), "max_wind_ms": extreme("wind_ms", max),
                "total_precip_mm": round(sum(h.precip_mm or 0.0 for h in hours), 2),
            }  # fmt: skip
        return _dump(out)

    @beta_tool
    def get_hourly_forecast(hours: int = 24) -> str:
        """Hourly weather rows from now: local time, dry-bulb, wet-bulb, humidity, wind, radiation, rain.

        Args:
            hours: Number of hours from now, 1 to 72.
        """
        note("get_hourly_forecast")
        rows = [
            {
                "local": _local(h.time, offset), "dry_bulb_c": h.t_2m_c, "wet_bulb_c": h.wet_bulb_c,
                "rh_pct": h.rh_pct, "wind_ms": h.wind_ms, "global_rad_w_m2": h.global_rad_w_m2,
                "precip_mm": h.precip_mm,
            }  # fmt: skip
            for h in ctx.weather.hourly[: max(1, min(int(hours), 72))]
        ]
        return _dump({"status": ctx.weather.status, "synthetic": ctx.weather.synthetic, "rows": rows})

    @beta_tool
    def get_operating_point() -> str:
        """The simulated operating point for the current hour: loads, temperatures, water balance, energy, capacity, constraints and warnings."""
        note("get_operating_point")
        if ctx.now is None:
            return _dump({"available": False, "reason": "No weather data, so no simulation."})
        p = ctx.now
        return _dump(
            {
                "simulated": True, "valid_local": _local(p.conditions.time, offset),
                "conditions": p.conditions.model_dump(exclude={"time"}),
                "set_points": p.config.model_dump(), "thermal": p.thermal.model_dump(),
                "water": p.water.model_dump(), "energy": p.energy.model_dump(),
                "capacity": p.capacity.model_dump(), "stress": p.stress.model_dump(),
                "constraints": [c.model_dump(exclude={"detail"}) for c in p.constraints if c.status != "n/a"],
                "feasible": p.feasible, "warnings": p.warnings,
            }  # fmt: skip
        )

    @beta_tool
    def get_projection() -> str:
        """Projection of the applied configuration over the forecast: 24 h and full-horizon totals and peaks, and the upcoming periods of high water demand or thermal stress."""
        note("get_projection")
        if ctx.projection is None:
            return _dump({"available": False, "reason": "No weather data, so no projection."})
        p = ctx.projection

        def window(s):
            """Summary with every timestamp shown in site local time."""
            out = {}
            for key, value in s.model_dump().items():
                if key.endswith("_time"):
                    out[key[:-5] + "_local"] = _local(value, offset)
                elif key in ("start", "end"):
                    out[key + "_local"] = _local(value, offset)
                else:
                    out[key] = value
            return out

        return _dump(
            {
                "simulated": True, "ambient_source": p.ambient_source,
                "next_24h": window(p.day), "horizon": window(p.horizon),
                "periods": [
                    {
                        "kind": x.kind, "from_local": _local(x.start, offset), "to_local": _local(x.end, offset),
                        "hours": x.hours, "peak": x.peak, "unit": x.unit, "level": x.level, "detail": x.detail,
                    }  # fmt: skip
                    for x in p.periods
                ],
            }
        )

    @beta_tool
    def get_optimisation() -> str:
        """The deterministic optimisation result: current, water-saving and balanced configurations with their set points, totals, changes against the current configuration, constraint status and solver notes, plus which one is recommended and why."""
        note("get_optimisation")
        if ctx.optimisation is None:
            return _dump({"available": False, "reason": "No weather data, so no optimisation."})
        r = ctx.optimisation
        scenarios = []
        for s in r.scenarios:
            summary = s.summary.model_dump(
                include={
                    "makeup_m3", "evaporation_m3", "blowdown_m3", "cooling_energy_kwh", "avg_wue_l_kwh",
                    "avg_ppue", "peak_makeup_m3_h", "peak_power_kw", "max_cws_c", "allocation_m3",
                    "allocation_utilisation", "min_tank_level_pct", "infeasible_hours",
                }  # fmt: skip
            )
            scenarios.append(
                {
                    "key": s.key, "label": s.label, "feasible": s.feasible, "set_points": s.config.model_dump(),
                    "totals": summary, "change_vs_current": s.deltas.model_dump() if s.deltas else None,
                    "set_point_changes": [c.model_dump(exclude={"key"}) for c in s.changes],
                    "objective": s.objective.model_dump() if s.objective else None,
                    "constraints": [
                        {"label": c.label, "value": c.value, "limit": c.limit, "unit": c.unit, "status": c.status}
                        for c in s.constraints if c.status != "n/a"
                    ],
                    "solver": s.solver.model_dump(), "why_infeasible": s.infeasibility,
                }  # fmt: skip
            )
        return _dump(
            {
                "simulated": True, "window_hours": r.window_hours, "ambient_source": r.ambient_source,
                "window_from_local": _local(r.window_start, offset), "window_to_local": _local(r.window_end, offset),
                "recommended": r.recommended, "recommendation_reason": r.recommendation_reason,
                "scenarios": scenarios,
                "tradeoff_by_evaporative_share": [p.model_dump() for p in r.tradeoff[::2]],
            }  # fmt: skip
        )

    @beta_tool
    def get_facility_and_assumptions() -> str:
        """Design data of the synthetic reference facility and the model assumptions behind every simulated number."""
        note("get_facility_and_assumptions")
        return _dump({"synthetic_reference_facility": ctx.facility.model_dump(), "model_assumptions": ASSUMPTIONS})

    tools = (
        get_weather_summary, get_hourly_forecast, get_operating_point,
        get_projection, get_optimisation, get_facility_and_assumptions,
    )  # fmt: skip
    return {t.name: t for t in tools}


def ask(
    role: Role,
    question: str,
    ctx: Context,
    model: str,
    client: anthropic.Anthropic | None = None,
) -> Answer:
    """One grounded answer from the given analyst role."""
    spec = ROLES[role]
    if client is None:
        if not credentials_present():
            raise LlmUnavailable("No Anthropic credentials are configured.")
        client = anthropic.Anthropic(timeout=90.0, max_retries=1)

    used: list[str] = []
    tools = build_tools(ctx, used)
    try:
        runner = client.beta.messages.tool_runner(
            model=model,
            max_tokens=16000,
            system=_SYSTEM.format(name=spec["name"], remit=spec["remit"]),
            tools=[tools[name] for name in spec["tools"]],
            messages=[{"role": "user", "content": question}],
            thinking={"type": "adaptive"},
            output_config={"effort": "medium"},
            # If a safety classifier declines, the API retries on a fallback model.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            max_iterations=8,
        )
        message = runner.until_done()
    except anthropic.AuthenticationError as exc:
        raise LlmUnavailable("Anthropic rejected the credentials.") from exc
    except anthropic.PermissionDeniedError as exc:
        raise LlmUnavailable("These Anthropic credentials are not permitted to use this model.") from exc
    except anthropic.NotFoundError as exc:
        raise LlmUnavailable(f"Model {model} was not found. Check COOLLOOP_LLM_MODEL.") from exc
    except anthropic.RateLimitError as exc:
        raise LlmUnavailable("Anthropic rate limit reached. Try again shortly.") from exc
    except anthropic.APIStatusError as exc:
        raise LlmUnavailable(f"Anthropic API error {exc.status_code}: {exc.message}") from exc
    except anthropic.APIConnectionError as exc:
        raise LlmUnavailable("Could not reach the Anthropic API.") from exc

    if message.stop_reason == "refusal":
        text = "The model declined to answer this question."
    else:
        text = "\n\n".join(b.text for b in message.content if b.type == "text").strip()
        if message.stop_reason == "max_tokens":
            text += "\n\n(The answer was cut short.)"
        if not text:
            text = "The model returned no answer."
    return Answer(
        role=role, analyst=spec["name"], question=question, answer=text, tools_used=used,
        model=message.model, generated_at=datetime.now(timezone.utc),
    )  # fmt: skip
