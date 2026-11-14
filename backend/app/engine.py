"""Application service: ties weather, simulation, optimisation and the
briefing together and owns the applied configuration."""

from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict
from datetime import datetime, timedelta, timezone

import numpy as np
from pydantic import BaseModel

from .analysis import build_alerts
from .config import Settings, env_file_mtime, load_settings
from .facility import FACILITY, PARAMETER_META, AmbientOverride, Location, OperatingConfig
from .intelligence import agents
from .intelligence.briefing import Briefing, build_briefing
from .optimizer import Window, build_scenario, changes_between, optimise_scenarios
from .physics.assumptions import ASSUMPTIONS
from .physics.plant import Ambient, Controls, simulate
from .projection import ambient_from_hours, ambient_from_override, project
from .report import point_result
from .schemas import (
    Alert,
    ApplyRequest,
    AuditEntry,
    Objective,
    OptimizationResult,
    OptimizeRequest,
    PointResult,
    Projection,
    Scenario,
    SettingsRequest,
    SimulateRequest,
    SolverInfo,
    WeatherBundle,
    WeatherExtremes,
    WindowSummary,
)
from .store import Store, utcnow
from .weather.service import WeatherService

# Conditions describe the situation; the other fields are set points.
CONDITION_KEYS = ("it_load_kw", "tower_cells_online", "water_allocation_m3_day")


class NoWeatherData(Exception):
    """Raised when a forecast-driven calculation is asked for without weather."""


class ControlSpec(BaseModel):
    key: str
    label: str
    unit: str
    scale: float  # multiply the stored value by this for display
    minimum: float
    maximum: float
    step: float
    group: str
    kind: str  # "condition" or "setpoint"
    hint: str


class FacilityInfo(BaseModel):
    id: str
    name: str
    synthetic: bool
    notice: str
    design: dict
    limits: dict


class ConfigMeta(BaseModel):
    applied_at: datetime | None
    source: str
    approved_by: str | None


class Overview(BaseModel):
    generated_at: datetime
    facility: FacilityInfo
    controls: list[ControlSpec]
    config: OperatingConfig
    config_meta: ConfigMeta
    weather: WeatherBundle
    now: PointResult | None
    projection: Projection | None
    alerts: list[Alert]
    assumptions: list[dict]
    llm: agents.LlmStatus


class SimulateResponse(BaseModel):
    simulated: bool = True
    ambient_source: str
    now: PointResult
    projection: Projection
    draft: Scenario  # the draft over the comparison window, against the applied set points
    baseline_config: OperatingConfig


def _control_specs() -> list[ControlSpec]:
    f = FACILITY
    rows = [
        ("it_load_kw", f.it_min_kw, f.it_design_kw, 100.0, "Load", "condition",
         "IT electrical load of the data hall."),
        ("water_allocation_m3_day", 0.0, 1500.0, 10.0, "Water", "condition",
         "Daily makeup water the site may draw."),
        ("tower_cells_online", 1, f.tower_cell_count, 1, "Configuration", "condition",
         "Tower cells in service. Fewer than four means a cell is out of service."),
        ("wet_fraction", 0.0, 1.0, 0.01, "Configuration", "setpoint",
         "Share of the cooling load on the towers. The rest goes to the air-cooled plant."),
        ("chw_supply_c", f.chw_supply_min_c, f.chw_supply_max_c, 0.1, "Set points", "setpoint",
         "Chilled water supply temperature."),
        ("tower_fan_speed", f.tower_fan_speed_min, 1.0, 0.01, "Towers and pumps", "setpoint",
         "Speed of every tower fan in service."),
        ("cw_pump_speed", f.cw_pump_speed_min, 1.0, 0.01, "Towers and pumps", "setpoint",
         "Speed of the condenser water pumps, which sets the flow."),
        ("cycles_of_concentration", f.coc_min, 10.0, 0.1, "Water", "setpoint",
         f"Tower water concentration. The assumed chemistry limit is {f.coc_max:g}."),
    ]  # fmt: skip
    out = []
    for key, lo, hi, step, group, kind, hint in rows:
        label, unit, scale = PARAMETER_META[key]
        out.append(
            ControlSpec(
                key=key, label=label, unit=unit, scale=scale, minimum=lo, maximum=hi, step=step,
                group=group, kind=kind, hint=hint,
            )  # fmt: skip
        )
    return out


def _facility_info() -> FacilityInfo:
    f = FACILITY
    return FacilityInfo(
        id=f.id,
        name=f.name,
        synthetic=True,
        notice="Synthetic reference facility. All plant values are simulated, none are measured.",
        design={
            "it_design_kw": f.it_design_kw,
            "rack_count": f.rack_count,
            "wc_chillers": f"{f.wc_chiller_count} x {f.wc_chiller_capacity_kw:,.0f} kW water-cooled (N+1)",
            "ac_chillers": f"{f.ac_chiller_count} x {f.ac_chiller_capacity_kw:,.0f} kW air-cooled",
            "tower_cells": f"{f.tower_cell_count} x {f.tower_design_rejection_kw:,.0f} kW counterflow cells (N+1)",
            "tower_design": (
                f"{f.tower_design_wet_bulb_c:g} °C wet-bulb, {f.tower_design_approach_k:g} K approach, "
                f"{f.tower_design_range_k:g} K range"
            ),
            "tank_capacity_m3": f.tank_capacity_m3,
        },
        limits={
            "cws_max_c": f.cws_max_c, "cws_min_c": f.cws_min_c, "server_inlet_limit_c": f.server_inlet_limit_c,
            "coc_max": f.coc_max, "tower_design_wet_bulb_c": f.tower_design_wet_bulb_c,
            "tank_reserve_pct": f.tank_reserve_fraction * 100.0, "it_design_kw": f.it_design_kw,
            "tower_cell_count": f.tower_cell_count, "tower_cells_duty": f.tower_cells_duty,
        },  # fmt: skip
    )


class Engine:
    def __init__(self, settings: Settings, weather: WeatherService | None = None, store: Store | None = None):
        self.settings = settings
        self.facility = FACILITY
        self.store = store or Store(settings.data_dir / "state.json", settings.site)
        self.weather = weather or WeatherService(settings, self.store)
        self._opt_lock = threading.Lock()
        self._opt_cache: OrderedDict[str, OptimizationResult] = OrderedDict()
        self._controls = _control_specs()
        self._facility_info = _facility_info()
        self._env_mtime = env_file_mtime()

    def _follow_env_file(self) -> None:
        """Pick up credentials saved to `.env` while the backend is running."""
        mtime = env_file_mtime()
        if mtime is None or mtime == self._env_mtime:
            return
        self._env_mtime = mtime
        fresh = load_settings()
        self.settings = Settings(**{**fresh.__dict__, "data_dir": self.settings.data_dir})
        self.weather.reconfigure(self.settings)

    # --- helpers --------------------------------------------------------------------
    def _base_config(self, draft: OperatingConfig | None) -> OperatingConfig:
        """Applied set points under the draft's conditions."""
        applied = self.store.config()
        if draft is None:
            return applied
        return applied.model_copy(update={k: getattr(draft, k) for k in CONDITION_KEYS})

    def _window(self, bundle: WeatherBundle, hours: int, override: AmbientOverride | None) -> Window:
        location = bundle.location
        if override is not None:
            # Same clock as the weather on screen: the present, or the replayed moment.
            start = bundle.hourly[0].time if bundle.hourly else utcnow().replace(minute=0, second=0, microsecond=0)
            times = [start + timedelta(hours=k) for k in range(hours)]
            return Window(times, ambient_from_override(override, location, hours), "manual")
        rows = bundle.hourly[:hours]
        if not rows:
            raise NoWeatherData(
                (bundle.error.message if bundle.error else bundle.notice)
                or "No weather data is available. Use a manual ambient or demo mode."
            )
        return Window([r.time for r in rows], ambient_from_hours(rows, location), "forecast")

    def _point(self, cfg: OperatingConfig, window: Window, bundle: WeatherBundle, index: int = 0) -> PointResult:
        amb = window.ambient
        pick = lambda v: float(np.atleast_1d(np.asarray(v, dtype=float))[min(index, np.size(v) - 1)])  # noqa: E731
        single = Ambient(
            t_db_c=pick(amb.t_db_c), t_wb_c=pick(amb.t_wb_c), pressure_pa=pick(amb.pressure_pa),
            wind_ms=pick(amb.wind_ms), ghi_w_m2=pick(amb.ghi_w_m2),
        )  # fmt: skip
        st = simulate(self.facility, Controls.from_config(cfg), single)
        return point_result(
            self.facility, cfg, st, 0, time=window.times[index], source=window.source,
            wind_ms=float(single.wind_ms), ghi_w_m2=float(single.ghi_w_m2),
        )  # fmt: skip

    # --- operations ---------------------------------------------------------------------
    def overview(self, horizon_hours: int = 72, force_weather: bool = False) -> Overview:
        self._follow_env_file()
        bundle = self.weather.bundle(force=force_weather)
        cfg = self.store.config()
        now = projection = None
        if bundle.hourly:
            window = self._window(bundle, horizon_hours, None)
            now = self._point(cfg, window, bundle)
            _, projection = project(self.facility, cfg, window.times, window.ambient)
        meta = self.store.config_meta()
        return Overview(
            generated_at=utcnow(),
            facility=self._facility_info,
            controls=self._controls,
            config=cfg,
            config_meta=ConfigMeta(**meta),
            weather=bundle,
            now=now,
            projection=projection,
            alerts=build_alerts(self.facility, cfg, bundle, now, projection),
            assumptions=ASSUMPTIONS,
            llm=agents.status(self.settings.llm_model),
        )

    # --- simulation -----------------------------------------------------------------------
    def simulate(self, req: SimulateRequest) -> SimulateResponse:
        bundle = self.weather.bundle()
        window = self._window(bundle, req.horizon_hours, req.ambient)
        now = self._point(req.config, window, bundle)
        _, projection = project(
            self.facility, req.config, window.times, window.ambient, ambient_source=window.source
        )
        base = self._base_config(req.config)
        compare = Window(
            window.times[: req.window_hours],
            _slice_ambient(window.ambient, req.window_hours),
            window.source,
        )
        untouched = SolverInfo(method="none", status="baseline", message="Applied set points.")
        baseline = build_scenario(
            self.facility, "baseline", "Current", "", base, base, compare, baseline=None, solver=untouched
        )
        draft = build_scenario(
            self.facility, "draft", "Draft", "Set points being edited, not applied.",
            req.config, base, compare, baseline=baseline.summary,
            solver=SolverInfo(method="none", status="manual", message="Operator-entered set points."),
        )  # fmt: skip
        return SimulateResponse(
            ambient_source=window.source, now=now, projection=projection, draft=draft, baseline_config=base
        )

    # --- optimisation ---------------------------------------------------------------------
    def optimise(self, req: OptimizeRequest) -> OptimizationResult:
        bundle = self.weather.bundle()
        window = self._window(bundle, req.window_hours, req.ambient)
        base = self._base_config(req.config)
        digest = hashlib.sha1()
        digest.update(base.model_dump_json().encode())
        digest.update(req.water_saving.model_dump_json().encode() + req.balanced.model_dump_json().encode())
        digest.update(window.source.encode() + str(window.times[0]).encode())
        for arr in (window.ambient.t_db_c, window.ambient.t_wb_c, window.ambient.pressure_pa):
            digest.update(np.round(np.asarray(arr, dtype=float), 4).tobytes())
        key = digest.hexdigest()
        with self._opt_lock:
            cached = self._opt_cache.get(key)
            if cached is not None:
                self._opt_cache.move_to_end(key)
                return cached
            result = optimise_scenarios(
                self.facility, base, window, req.water_saving, req.balanced
            )
            self._opt_cache[key] = result
            while len(self._opt_cache) > 16:
                self._opt_cache.popitem(last=False)
            return result

    # --- operator decisions -----------------------------------------------------------------
    def apply(self, req: ApplyRequest) -> Overview:
        if not req.confirm:
            raise PermissionError("Applying a configuration needs explicit operator approval.")
        before = self.store.config()
        entry = AuditEntry(
            at=utcnow(), action="applied", source=req.source, approved_by=req.approved_by,
            note=req.note, changes=changes_between(before, req.config),
        )  # fmt: skip
        self.store.apply_config(req.config, entry)
        return self.overview()

    def reset(self, approved_by: str) -> Overview:
        before = self.store.config()
        baseline = OperatingConfig()
        entry = AuditEntry(
            at=utcnow(), action="reset", source="reference baseline", approved_by=approved_by,
            changes=changes_between(before, baseline),
        )  # fmt: skip
        self.store.apply_config(baseline, entry)
        return self.overview()

    def dismiss(self, source: str, approved_by: str, note: str) -> list[AuditEntry]:
        self.store.log(
            AuditEntry(at=utcnow(), action="dismissed", source=source, approved_by=approved_by, note=note)
        )
        return self.store.audit()

    def update_settings(self, req: SettingsRequest) -> Overview:
        if req.replay_at is not None:
            # A time sent without a zone is taken as UTC, like every other timestamp here.
            moment = req.replay_at if req.replay_at.tzinfo else req.replay_at.replace(tzinfo=timezone.utc)
            if moment > utcnow():
                raise ValueError("A replay has to start in the past.")
            self.store.set_replay_at(moment)
        if req.weather_mode == "replay" and self.store.replay_at() is None:
            raise ValueError("Choose a date and time to replay.")
        if req.location is not None:
            self.store.set_location(req.location)
        if req.weather_mode is not None:
            self.store.set_weather_mode(req.weather_mode)
        return self.overview(force_weather=req.location is not None)

    def extremes(self) -> WeatherExtremes:
        self._follow_env_file()
        return self.weather.extremes()

    # --- intelligence -------------------------------------------------------------------------
    def _previous_day(self, bundle: WeatherBundle, cfg: OperatingConfig) -> WindowSummary | None:
        """The applied configuration simulated over the preceding hours."""
        rows = bundle.history[-24:]
        if len(rows) < 12:
            return None
        try:
            _, past = project(
                self.facility, cfg, [r.time for r in rows], ambient_from_hours(rows, bundle.location)
            )
        except ValueError:
            return None
        return past.horizon

    def _context(self) -> tuple[agents.Context, WindowSummary | None, str]:
        overview = self.overview()
        optimisation = None
        if overview.weather.hourly:
            optimisation = self.optimise(OptimizeRequest())
        ctx = agents.Context(
            facility=self.facility, config=overview.config, weather=overview.weather,
            now=overview.now, projection=overview.projection, optimisation=optimisation,
        )  # fmt: skip
        previous = self._previous_day(overview.weather, overview.config)
        return ctx, previous, overview.config_meta.source

    def briefing(self) -> Briefing:
        ctx, previous, source = self._context()
        return build_briefing(
            self.facility, ctx.weather, ctx.now, ctx.projection, previous, ctx.optimisation,
            source, self.store.audit(),
        )  # fmt: skip

    def ask(self, role: str, question: str) -> agents.Answer:
        ctx, _, _ = self._context()
        return agents.ask(role, question, ctx, self.settings.llm_model)


def _slice_ambient(amb: Ambient, hours: int) -> Ambient:
    cut = lambda v: np.atleast_1d(np.asarray(v, dtype=float))[:hours]  # noqa: E731
    return Ambient(
        t_db_c=cut(amb.t_db_c), t_wb_c=cut(amb.t_wb_c), pressure_pa=cut(amb.pressure_pa),
        wind_ms=cut(amb.wind_ms), ghi_w_m2=cut(amb.ghi_w_m2),
    )  # fmt: skip


__all__ = ["Engine", "NoWeatherData", "Overview", "SimulateResponse", "Location", "Objective"]
