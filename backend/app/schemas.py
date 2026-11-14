"""Typed API payloads. Units are part of every field name."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from .facility import AmbientOverride, Facility, Location, OperatingConfig

Status = Literal["ok", "warning", "violated", "n/a"]
StressLevel = Literal["nominal", "elevated", "high", "critical"]
EquipmentStatus = Literal["running", "standby", "off", "warning", "fault"]


# --- weather -----------------------------------------------------------------
class WeatherHour(BaseModel):
    time: datetime
    t_2m_c: float | None = None
    wet_bulb_c: float | None = None
    rh_pct: float | None = None
    dew_point_c: float | None = None
    wind_ms: float | None = None
    global_rad_w_m2: float | None = None
    precip_mm: float | None = None
    evaporation_mm: float | None = None  # environmental, positive = evaporation
    pressure_hpa: float | None = None


class WeatherParameter(BaseModel):
    id: str  # Meteomatics identifier, e.g. "wet_bulb_t_2m:C"
    field: str  # WeatherHour field it fills
    label: str
    role: str  # what the simulation uses it for
    source: Literal["api", "derived", "synthetic", "unavailable"]
    detail: str = ""


class WeatherQuota(BaseModel):
    used_today: int | None = None
    limit_today: int | None = None
    used_minute: int | None = None
    limit_minute: int | None = None
    historic_access: bool | None = None
    historic_range: str | None = None  # as reported by the account
    plan: str | None = None
    valid_until: datetime | None = None  # when the account expires
    checked_at: datetime | None = None


class WeatherError(BaseModel):
    kind: str
    message: str
    at: datetime
    http_status: int | None = None


class WeatherExtreme(BaseModel):
    """An hour of real past weather that is worth replaying."""

    kind: Literal["wet_bulb", "dry_bulb", "dry_air"]
    label: str
    detail: str
    time: datetime  # the extreme hour itself
    replay_from: datetime  # a little earlier, so the event is still ahead
    t_2m_c: float
    wet_bulb_c: float
    rh_pct: float | None = None


class WeatherExtremes(BaseModel):
    scanned_from: datetime
    scanned_to: datetime
    hours: int
    source: str
    extremes: list[WeatherExtreme]


class WeatherBundle(BaseModel):
    mode: Literal["live", "demo", "replay"]
    status: Literal["live", "cached", "demo", "replay", "unavailable", "not_configured"]
    replay_at: datetime | None = None  # the past moment being replayed as "now"
    synthetic: bool
    provider: str
    model: str | None = None
    location: Location
    fetched_at: datetime | None = None  # when this dataset was retrieved
    last_success_at: datetime | None = None  # last successful live API call
    api_generated_at: datetime | None = None  # `dateGenerated` reported by the API
    next_refresh_at: datetime | None = None
    stale: bool = False
    error: WeatherError | None = None
    wet_bulb_source: Literal["api", "derived", "synthetic", "unavailable"] = "unavailable"
    current: WeatherHour | None = None
    hourly: list[WeatherHour] = Field(default_factory=list)  # from the current hour onward
    history: list[WeatherHour] = Field(default_factory=list)  # preceding hours
    parameters: list[WeatherParameter] = Field(default_factory=list)
    quota: WeatherQuota | None = None
    notice: str = ""


# --- simulation --------------------------------------------------------------
class Conditions(BaseModel):
    time: datetime | None = None
    source: Literal["forecast", "manual"] = "forecast"
    t_db_c: float
    t_wb_c: float
    rh_pct: float
    pressure_hpa: float
    wind_ms: float
    ghi_w_m2: float


class Thermal(BaseModel):
    it_load_kw: float
    envelope_gain_kw: float
    cooling_load_kw: float
    wet_load_kw: float
    dry_load_kw: float
    wet_fraction: float
    heat_rejection_kw: float
    heat_rejection_wet_kw: float
    heat_rejection_dry_kw: float
    latent_kw: float
    sensible_kw: float
    latent_fraction: float | None
    chw_supply_c: float
    chw_return_c: float
    chw_flow_m3_h: float
    cws_c: float | None
    cwr_c: float | None
    range_k: float | None
    approach_k: float | None
    cw_flow_m3_h: float
    tower_air_flow_kg_s: float
    tower_air_out_c: float | None
    lg_ratio: float | None
    ntu: float | None
    wc_cop: float | None
    ac_cop: float | None
    ac_condensing_c: float | None
    server_inlet_c: float


class Water(BaseModel):
    evaporation_m3_h: float
    blowdown_m3_h: float
    drift_m3_h: float
    makeup_m3_h: float
    makeup_m3_day: float  # current rate held for 24 h
    balance_residual_m3_h: float  # makeup - (evaporation + blowdown + drift)
    cycles_of_concentration: float
    evaporation_pct_of_flow: float | None
    wue_l_kwh: float
    allocation_m3_day: float
    allocation_utilisation: float | None
    tank_level_pct: float
    tank_volume_m3: float
    autonomy_h: float | None


class Energy(BaseModel):
    wc_chiller_kw: float
    ac_chiller_kw: float
    tower_fan_kw: float
    cw_pump_kw: float
    chw_pump_kw: float
    ac_fan_kw: float
    crah_fan_kw: float
    cooling_power_kw: float
    ppue: float
    kw_per_kw_cooling: float


class Capacity(BaseModel):
    cooling_capacity_kw: float
    wet_capacity_kw: float
    dry_capacity_kw: float
    tower_rejection_capacity_kw: float
    margin_kw: float
    utilisation: float


class Constraint(BaseModel):
    id: str
    label: str
    value: float | None
    limit: float | None
    unit: str
    kind: Literal["max", "min"]
    margin: float | None
    status: Status
    detail: str = ""


class Stress(BaseModel):
    index: float
    level: StressLevel
    driver: str
    components: dict[str, float]


class Metric(BaseModel):
    label: str
    value: float | None
    unit: str = ""
    digits: int = 1


class EquipmentState(BaseModel):
    id: str
    tag: str
    name: str
    kind: str
    state: EquipmentStatus
    summary: str
    metrics: list[Metric] = Field(default_factory=list)


class PointResult(BaseModel):
    """One steady-state operating point. All values are simulated."""

    simulated: bool = True
    conditions: Conditions
    config: OperatingConfig
    thermal: Thermal
    water: Water
    energy: Energy
    capacity: Capacity
    constraints: list[Constraint]
    stress: Stress
    feasible: bool
    warnings: list[str]
    equipment: list[EquipmentState]


class WindowSummary(BaseModel):
    hours: int
    start: datetime | None
    end: datetime | None
    makeup_m3: float
    evaporation_m3: float
    blowdown_m3: float
    drift_m3: float
    cooling_energy_kwh: float
    it_energy_kwh: float
    avg_wue_l_kwh: float
    avg_ppue: float
    peak_makeup_m3_h: float
    peak_makeup_time: datetime | None
    peak_power_kw: float
    peak_power_time: datetime | None
    max_cws_c: float | None
    max_cws_time: datetime | None
    max_wet_bulb_c: float
    max_wet_bulb_time: datetime | None
    max_stress: float
    max_stress_time: datetime | None
    min_capacity_margin_kw: float
    allocation_m3: float
    allocation_utilisation: float | None
    min_tank_level_pct: float
    infeasible_hours: int


class Period(BaseModel):
    kind: Literal["water", "thermal", "dry", "stress"]
    start: datetime
    end: datetime
    hours: int
    peak: float
    unit: str
    level: StressLevel
    detail: str


class Projection(BaseModel):
    """Hour-by-hour projection of one configuration over the forecast."""

    simulated: bool = True
    ambient_source: Literal["forecast", "manual"] = "forecast"
    times: list[datetime]
    t_db_c: list[float]
    t_wb_c: list[float]
    rh_pct: list[float]
    cooling_load_kw: list[float]
    heat_rejection_kw: list[float]
    makeup_m3_h: list[float]
    evaporation_m3_h: list[float]
    blowdown_m3_h: list[float]
    drift_m3_h: list[float]
    cooling_power_kw: list[float]
    cws_c: list[float | None]
    approach_k: list[float | None]
    latent_fraction: list[float | None]
    wc_cop: list[float | None]
    wue_l_kwh: list[float]
    ppue: list[float]
    capacity_margin_kw: list[float]
    tank_level_pct: list[float]
    stress: list[float]
    stress_level: list[StressLevel]
    stress_driver: list[str]
    feasible: list[bool]
    day: WindowSummary  # first 24 h
    horizon: WindowSummary  # the whole projection
    periods: list[Period]


class Alert(BaseModel):
    id: str
    severity: Literal["info", "warning", "critical"]
    title: str
    detail: str
    source: str  # which verified quantity triggered it
    time: datetime | None = None


# --- optimisation ------------------------------------------------------------
class Objective(BaseModel):
    w_water: float = Field(0.5, ge=0.0, le=1.0)
    w_energy: float = Field(0.5, ge=0.0, le=1.0)


class ObjectiveValue(BaseModel):
    value: float
    w_water: float
    w_energy: float
    water_term: float  # window makeup / baseline makeup
    energy_term: float  # window cooling energy / baseline cooling energy


class SolverInfo(BaseModel):
    method: str
    status: Literal["optimal", "baseline", "infeasible", "manual"]
    message: str
    evaluations: int = 0
    starts: int = 0
    runtime_ms: float = 0.0


class ParameterChange(BaseModel):
    key: str
    label: str
    unit: str
    before: float
    after: float


class Deltas(BaseModel):
    makeup_m3: float
    makeup_pct: float | None
    energy_kwh: float
    energy_pct: float | None
    peak_power_kw: float
    max_cws_k: float | None


class Scenario(BaseModel):
    key: Literal["baseline", "water_saving", "balanced", "draft"]
    label: str
    description: str
    config: OperatingConfig
    feasible: bool
    objective: ObjectiveValue | None
    summary: WindowSummary
    deltas: Deltas | None  # versus the baseline scenario
    changes: list[ParameterChange]
    constraints: list[Constraint]  # worst hour of the window
    solver: SolverInfo
    infeasibility: list[str] = Field(default_factory=list)
    hourly_makeup_m3_h: list[float]
    hourly_power_kw: list[float]
    hourly_cws_c: list[float | None]
    hourly_tank_level_pct: list[float]


class TradeoffPoint(BaseModel):
    wet_fraction: float
    makeup_m3: float
    energy_kwh: float
    feasible: bool


class OptimizationResult(BaseModel):
    simulated: bool = True
    generated_at: datetime
    window_hours: int
    window_start: datetime | None
    window_end: datetime | None
    ambient_source: Literal["forecast", "manual"]
    times: list[datetime]
    scenarios: list[Scenario]
    tradeoff: list[TradeoffPoint]
    recommended: Literal["baseline", "water_saving", "balanced"]
    recommendation_reason: str


# --- requests ----------------------------------------------------------------
class SimulateRequest(BaseModel):
    config: OperatingConfig  # the draft being edited
    ambient: AmbientOverride | None = None  # manual ambient instead of the forecast
    horizon_hours: int = Field(72, ge=6, le=168)  # projection length
    window_hours: int = Field(24, ge=6, le=72)  # comparison window


class OptimizeRequest(BaseModel):
    # Only the conditions (IT load, cells in service, water allocation) are
    # taken from this config; the baseline set points are the applied ones.
    config: OperatingConfig | None = None
    ambient: AmbientOverride | None = None
    window_hours: int = Field(24, ge=6, le=72)
    water_saving: Objective = Objective(w_water=0.85, w_energy=0.15)
    balanced: Objective = Objective(w_water=0.5, w_energy=0.5)


class ApplyRequest(BaseModel):
    config: OperatingConfig
    source: str = Field("manual", max_length=60)
    note: str = Field("", max_length=400)
    approved_by: str = Field("Operator", max_length=60)
    confirm: bool = False  # explicit human approval is mandatory


class SettingsRequest(BaseModel):
    location: Location | None = None
    weather_mode: Literal["live", "demo", "replay"] | None = None
    replay_at: datetime | None = None  # required when switching to replay


class AuditEntry(BaseModel):
    at: datetime
    action: Literal["applied", "dismissed", "reset"]
    source: str
    approved_by: str
    note: str = ""
    changes: list[ParameterChange] = Field(default_factory=list)


__all__ = [name for name in dir() if not name.startswith("_")] + [
    "Facility",
    "Location",
    "OperatingConfig",
    "AmbientOverride",
]
