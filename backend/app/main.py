"""HTTP API. Routes only: every calculation lives in the modules they call.

Run from the `backend` folder:
    uvicorn app.main:app --port 8000
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import get_settings
from .engine import Engine, NoWeatherData, Overview, SimulateResponse
from .intelligence.agents import Answer, LlmUnavailable
from .intelligence.briefing import Briefing
from .schemas import (
    ApplyRequest,
    AuditEntry,
    OptimizationResult,
    OptimizeRequest,
    SettingsRequest,
    SimulateRequest,
)

app = FastAPI(
    title="COOLLOOP API",
    version="1.0.0",
    description=(
        "Weather intelligence, physics simulation and optimisation for a synthetic "
        "hybrid-cooled reference data centre. All plant values are simulated."
    ),
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    return Engine(get_settings())


class AskRequest(BaseModel):
    role: Literal["climate", "thermal", "planner"]
    question: str = Field(..., min_length=3, max_length=600)


class OperatorAction(BaseModel):
    approved_by: str = Field("Operator", max_length=60)
    source: str = Field("recommendation", max_length=60)
    note: str = Field("", max_length=400)
    confirm: bool = False


def _no_weather(exc: NoWeatherData) -> HTTPException:
    return HTTPException(status_code=409, detail=str(exc))


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/overview", response_model=Overview)
def overview(horizon_hours: int = 72, engine: Engine = Depends(get_engine)) -> Overview:
    return engine.overview(max(6, min(horizon_hours, 168)))


@app.post("/api/weather/refresh", response_model=Overview)
def refresh_weather(engine: Engine = Depends(get_engine)) -> Overview:
    """Force a live weather request now (still subject to the quota guard)."""
    return engine.overview(force_weather=True)


@app.put("/api/settings", response_model=Overview)
def update_settings(req: SettingsRequest, engine: Engine = Depends(get_engine)) -> Overview:
    return engine.update_settings(req)


@app.post("/api/simulate", response_model=SimulateResponse)
def simulate(req: SimulateRequest, engine: Engine = Depends(get_engine)) -> SimulateResponse:
    try:
        return engine.simulate(req)
    except NoWeatherData as exc:
        raise _no_weather(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/optimize", response_model=OptimizationResult)
def optimise(req: OptimizeRequest, engine: Engine = Depends(get_engine)) -> OptimizationResult:
    try:
        return engine.optimise(req)
    except NoWeatherData as exc:
        raise _no_weather(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/config/apply", response_model=Overview)
def apply_config(req: ApplyRequest, engine: Engine = Depends(get_engine)) -> Overview:
    """Apply a configuration to the simulated facility. Human approval is
    mandatory: the request is refused unless `confirm` is true."""
    try:
        return engine.apply(req)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.post("/api/config/reset", response_model=Overview)
def reset_config(req: OperatorAction, engine: Engine = Depends(get_engine)) -> Overview:
    if not req.confirm:
        raise HTTPException(status_code=403, detail="Resetting the configuration needs operator approval.")
    return engine.reset(req.approved_by)


@app.post("/api/recommendation/dismiss", response_model=list[AuditEntry])
def dismiss(req: OperatorAction, engine: Engine = Depends(get_engine)) -> list[AuditEntry]:
    return engine.dismiss(req.source, req.approved_by, req.note)


@app.get("/api/intelligence", response_model=Briefing)
def intelligence(engine: Engine = Depends(get_engine)) -> Briefing:
    return engine.briefing()


@app.post("/api/intelligence/ask", response_model=Answer)
def ask(req: AskRequest, engine: Engine = Depends(get_engine)) -> Answer:
    try:
        return engine.ask(req.role, req.question)
    except LlmUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
