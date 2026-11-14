// Mirrors the backend payloads (backend/app/schemas.py, engine.py, intelligence/).
// Units are part of every field name.

export type Status = "ok" | "warning" | "violated" | "n/a";
export type StressLevel = "nominal" | "elevated" | "high" | "critical";
export type EquipmentStatus = "running" | "standby" | "off" | "warning" | "fault";
export type ScenarioKey = "baseline" | "water_saving" | "balanced" | "draft";

export interface Location {
  name: string;
  lat: number;
  lon: number;
  utc_offset_hours: number;
  elevation_m: number;
}

export interface OperatingConfig {
  it_load_kw: number;
  chw_supply_c: number;
  tower_fan_speed: number;
  cw_pump_speed: number;
  cycles_of_concentration: number;
  wet_fraction: number;
  tower_cells_online: number;
  water_allocation_m3_day: number;
}

export interface AmbientOverride {
  t_db_c: number;
  rh_pct: number;
}

export interface WeatherHour {
  time: string;
  t_2m_c: number | null;
  wet_bulb_c: number | null;
  rh_pct: number | null;
  dew_point_c: number | null;
  wind_ms: number | null;
  global_rad_w_m2: number | null;
  precip_mm: number | null;
  evaporation_mm: number | null;
  pressure_hpa: number | null;
}

export interface WeatherParameter {
  id: string;
  field: string;
  label: string;
  role: string;
  source: "api" | "derived" | "synthetic" | "unavailable";
  detail: string;
}

/** An hour of real past weather worth replaying. */
export interface WeatherExtreme {
  kind: "wet_bulb" | "dry_bulb" | "dry_air";
  label: string;
  detail: string;
  time: string;
  /** A little before `time`, so the event is still ahead when the replay starts. */
  replay_from: string;
  t_2m_c: number;
  wet_bulb_c: number;
  rh_pct: number | null;
}

export interface WeatherExtremes {
  scanned_from: string;
  scanned_to: string;
  hours: number;
  source: string;
  extremes: WeatherExtreme[];
}

export interface WeatherBundle {
  mode: "live" | "demo" | "replay";
  status: "live" | "cached" | "demo" | "replay" | "unavailable" | "not_configured";
  /** The past moment being replayed as "now". Null outside replay mode. */
  replay_at: string | null;
  synthetic: boolean;
  provider: string;
  model: string | null;
  location: Location;
  fetched_at: string | null;
  last_success_at: string | null;
  api_generated_at: string | null;
  next_refresh_at: string | null;
  stale: boolean;
  error: { kind: string; message: string; at: string; http_status: number | null } | null;
  wet_bulb_source: "api" | "derived" | "synthetic" | "unavailable";
  current: WeatherHour | null;
  hourly: WeatherHour[];
  history: WeatherHour[];
  parameters: WeatherParameter[];
  quota: {
    used_today: number | null;
    limit_today: number | null;
    used_minute: number | null;
    limit_minute: number | null;
    historic_access: boolean | null;
    historic_range: string | null;
    plan: string | null;
    valid_until: string | null;
    checked_at: string | null;
  } | null;
  notice: string;
}

export interface Conditions {
  time: string | null;
  source: "forecast" | "manual";
  t_db_c: number;
  t_wb_c: number;
  rh_pct: number;
  pressure_hpa: number;
  wind_ms: number;
  ghi_w_m2: number;
}

export interface Thermal {
  it_load_kw: number;
  envelope_gain_kw: number;
  cooling_load_kw: number;
  wet_load_kw: number;
  dry_load_kw: number;
  wet_fraction: number;
  heat_rejection_kw: number;
  heat_rejection_wet_kw: number;
  heat_rejection_dry_kw: number;
  latent_kw: number;
  sensible_kw: number;
  latent_fraction: number | null;
  chw_supply_c: number;
  chw_return_c: number;
  chw_flow_m3_h: number;
  cws_c: number | null;
  cwr_c: number | null;
  range_k: number | null;
  approach_k: number | null;
  cw_flow_m3_h: number;
  tower_air_flow_kg_s: number;
  tower_air_out_c: number | null;
  lg_ratio: number | null;
  ntu: number | null;
  wc_cop: number | null;
  ac_cop: number | null;
  ac_condensing_c: number | null;
  server_inlet_c: number;
}

export interface Water {
  evaporation_m3_h: number;
  blowdown_m3_h: number;
  drift_m3_h: number;
  makeup_m3_h: number;
  makeup_m3_day: number;
  balance_residual_m3_h: number;
  cycles_of_concentration: number;
  evaporation_pct_of_flow: number | null;
  wue_l_kwh: number;
  allocation_m3_day: number;
  allocation_utilisation: number | null;
  tank_level_pct: number;
  tank_volume_m3: number;
  autonomy_h: number | null;
}

export interface Energy {
  wc_chiller_kw: number;
  ac_chiller_kw: number;
  tower_fan_kw: number;
  cw_pump_kw: number;
  chw_pump_kw: number;
  ac_fan_kw: number;
  crah_fan_kw: number;
  cooling_power_kw: number;
  ppue: number;
  kw_per_kw_cooling: number;
}

export interface Capacity {
  cooling_capacity_kw: number;
  wet_capacity_kw: number;
  dry_capacity_kw: number;
  tower_rejection_capacity_kw: number;
  margin_kw: number;
  utilisation: number;
}

export interface Constraint {
  id: string;
  label: string;
  value: number | null;
  limit: number | null;
  unit: string;
  kind: "max" | "min";
  margin: number | null;
  status: Status;
  detail: string;
}

export interface Stress {
  index: number;
  level: StressLevel;
  driver: string;
  components: Record<string, number>;
}

export interface Metric {
  label: string;
  value: number | null;
  unit: string;
  digits: number;
}

export interface EquipmentState {
  id: string;
  tag: string;
  name: string;
  kind: string;
  state: EquipmentStatus;
  summary: string;
  metrics: Metric[];
}

export interface PointResult {
  simulated: boolean;
  conditions: Conditions;
  config: OperatingConfig;
  thermal: Thermal;
  water: Water;
  energy: Energy;
  capacity: Capacity;
  constraints: Constraint[];
  stress: Stress;
  feasible: boolean;
  warnings: string[];
  equipment: EquipmentState[];
}

export interface WindowSummary {
  hours: number;
  start: string | null;
  end: string | null;
  makeup_m3: number;
  evaporation_m3: number;
  blowdown_m3: number;
  drift_m3: number;
  cooling_energy_kwh: number;
  it_energy_kwh: number;
  avg_wue_l_kwh: number;
  avg_ppue: number;
  peak_makeup_m3_h: number;
  peak_makeup_time: string | null;
  peak_power_kw: number;
  peak_power_time: string | null;
  max_cws_c: number | null;
  max_cws_time: string | null;
  max_wet_bulb_c: number;
  max_wet_bulb_time: string | null;
  max_stress: number;
  max_stress_time: string | null;
  min_capacity_margin_kw: number;
  allocation_m3: number;
  allocation_utilisation: number | null;
  min_tank_level_pct: number;
  infeasible_hours: number;
}

export interface Period {
  kind: "water" | "thermal" | "dry" | "stress";
  start: string;
  end: string;
  hours: number;
  peak: number;
  unit: string;
  level: StressLevel;
  detail: string;
}

export interface Projection {
  simulated: boolean;
  ambient_source: "forecast" | "manual";
  times: string[];
  t_db_c: number[];
  t_wb_c: number[];
  rh_pct: number[];
  cooling_load_kw: number[];
  heat_rejection_kw: number[];
  makeup_m3_h: number[];
  evaporation_m3_h: number[];
  blowdown_m3_h: number[];
  drift_m3_h: number[];
  cooling_power_kw: number[];
  cws_c: (number | null)[];
  approach_k: (number | null)[];
  latent_fraction: (number | null)[];
  wc_cop: (number | null)[];
  wue_l_kwh: number[];
  ppue: number[];
  capacity_margin_kw: number[];
  tank_level_pct: number[];
  stress: number[];
  stress_level: StressLevel[];
  stress_driver: string[];
  feasible: boolean[];
  day: WindowSummary;
  horizon: WindowSummary;
  periods: Period[];
}

export interface Alert {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  source: string;
  time: string | null;
}

export interface ParameterChange {
  key: string;
  label: string;
  unit: string;
  before: number;
  after: number;
}

export interface Deltas {
  makeup_m3: number;
  makeup_pct: number | null;
  energy_kwh: number;
  energy_pct: number | null;
  peak_power_kw: number;
  max_cws_k: number | null;
}

export interface Scenario {
  key: ScenarioKey;
  label: string;
  description: string;
  config: OperatingConfig;
  feasible: boolean;
  objective: {
    value: number;
    w_water: number;
    w_energy: number;
    water_term: number;
    energy_term: number;
  } | null;
  summary: WindowSummary;
  deltas: Deltas | null;
  changes: ParameterChange[];
  constraints: Constraint[];
  solver: {
    method: string;
    status: "optimal" | "baseline" | "infeasible" | "manual";
    message: string;
    evaluations: number;
    starts: number;
    runtime_ms: number;
  };
  infeasibility: string[];
  hourly_makeup_m3_h: number[];
  hourly_power_kw: number[];
  hourly_cws_c: (number | null)[];
  hourly_tank_level_pct: number[];
}

export interface TradeoffPoint {
  wet_fraction: number;
  makeup_m3: number;
  energy_kwh: number;
  feasible: boolean;
}

export interface OptimizationResult {
  simulated: boolean;
  generated_at: string;
  window_hours: number;
  window_start: string | null;
  window_end: string | null;
  ambient_source: "forecast" | "manual";
  times: string[];
  scenarios: Scenario[];
  tradeoff: TradeoffPoint[];
  recommended: "baseline" | "water_saving" | "balanced";
  recommendation_reason: string;
}

export interface ControlSpec {
  key: keyof OperatingConfig;
  label: string;
  unit: string;
  scale: number;
  minimum: number;
  maximum: number;
  step: number;
  group: string;
  kind: "condition" | "setpoint";
  hint: string;
}

export interface Assumption {
  id: string;
  area: string;
  text: string;
  reference?: string;
}

export interface LlmStatus {
  available: boolean;
  provider: string;
  model: string;
  detail: string;
}

export interface Overview {
  generated_at: string;
  facility: {
    id: string;
    name: string;
    synthetic: boolean;
    notice: string;
    design: Record<string, string | number>;
    limits: Record<string, number>;
  };
  controls: ControlSpec[];
  config: OperatingConfig;
  config_meta: { applied_at: string | null; source: string; approved_by: string | null };
  weather: WeatherBundle;
  now: PointResult | null;
  projection: Projection | null;
  alerts: Alert[];
  assumptions: Assumption[];
  llm: LlmStatus;
}

export interface SimulateResponse {
  simulated: boolean;
  ambient_source: "forecast" | "manual";
  now: PointResult;
  projection: Projection;
  draft: Scenario;
  baseline_config: OperatingConfig;
}

export type Severity = "info" | "watch" | "warning" | "critical";

export interface Finding {
  title: string;
  detail: string;
  severity: Severity;
  evidence: Metric[];
}

export interface AnalystSection {
  role: "climate" | "thermal" | "planner";
  name: string;
  remit: string;
  headline: string;
  findings: Finding[];
}

export interface Recommendation {
  scenario_key: string;
  label: string;
  actionable: boolean;
  feasible: boolean;
  reason: string;
  window_hours: number;
  config: OperatingConfig;
  changes: ParameterChange[];
  rationale: string[];
  deltas: Deltas | null;
  summary: WindowSummary;
  baseline_summary: WindowSummary;
  constraints: Constraint[];
  approval_note: string;
}

export interface AuditEntry {
  at: string;
  action: "applied" | "dismissed" | "reset";
  source: string;
  approved_by: string;
  note: string;
  changes: ParameterChange[];
}

export interface Briefing {
  simulated: boolean;
  generated_at: string;
  basis: {
    weather_status: string;
    weather_source: string;
    weather_synthetic: boolean;
    weather_fetched_at: string | null;
    forecast_from: string | null;
    forecast_to: string | null;
    window_hours: number;
    config_source: string;
  };
  sections: AnalystSection[];
  recommendation: Recommendation | null;
  audit: AuditEntry[];
}

export interface Answer {
  role: "climate" | "thermal" | "planner";
  analyst: string;
  question: string;
  answer: string;
  tools_used: string[];
  model: string;
  generated_at: string;
}
