"use client";

import { useEffect, useMemo, useState } from "react";
import { num } from "@/lib/format";
import { CONDITION_KEYS, useApp, useOffset } from "@/lib/store";
import type { Constraint, ControlSpec, OperatingConfig, Scenario, ScenarioKey } from "@/lib/types";
import { ApprovalDialog, type ApprovalRequest, diffConfig } from "../Approval";
import { type Series, TimeChart, TradeoffChart } from "../charts";
import { TwinSlot } from "../twin/TwinViewport";
import { Btn, CHECK_COLOUR, CHECK_LABEL, Choice, Delta, Icon, Note, Section, Skeleton, Stat, Tag } from "../ui";

const SCENARIO_COLOUR: Record<ScenarioKey, string> = {
  baseline: "var(--color-neutral)",
  water_saving: "var(--color-s1)",
  balanced: "var(--color-s3)",
  draft: "var(--color-s2)",
};
const SETPOINT_KEYS = ["wet_fraction", "chw_supply_c", "tower_fan_speed", "cw_pump_speed", "cycles_of_concentration"] as const;
// Fixed ambient conditions worth rehearsing in a hot, arid climate.
const AMBIENT_CASES = [
  { label: "Dry afternoon", t: 46, rh: 12 },
  { label: "Humid night", t: 34, rh: 80 },
  { label: "Tower design day", t: 36, rh: 65 },
  { label: "Mild", t: 27, rh: 50 },
];

// --- parameter panel ------------------------------------------------------------------
function Slider({
  label,
  unit,
  value,
  min,
  max,
  step,
  digits,
  onChange,
  hint,
  disabled,
  mark,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits: number;
  onChange: (v: number) => void;
  hint?: string;
  disabled?: boolean;
  mark?: { value: number; label: string };
}) {
  const [text, setText] = useState<string | null>(null);
  const fill = ((value - min) / (max - min)) * 100;
  const commit = (raw: string) => {
    const v = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
    setText(null);
  };
  return (
    <div className={disabled ? "opacity-50" : ""}>
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-[11.5px] text-ink-2" title={hint}>
          {label}
        </label>
        <span className="flex items-baseline gap-1">
          <input
            type="number"
            value={text ?? num(value, digits).replace(/,/g, "")}
            step={step}
            min={min}
            max={max}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label={label}
            className="num h-[22px] w-[62px] border border-transparent bg-transparent px-1 text-right text-[12.5px] text-ink outline-none hover:border-line-2 focus:border-accent focus:bg-inset"
          />
          <span className="w-[42px] text-[10.5px] text-ink-3">{unit}</span>
        </span>
      </div>
      <div className="relative">
        <input
          type="range"
          className="slider"
          style={{ "--fill": `${fill}%` } as React.CSSProperties}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {mark && (
          <span
            className="pointer-events-none absolute top-[3px] h-[10px] w-px bg-warn"
            style={{ left: `calc(${((mark.value - min) / (max - min)) * 100}% )` }}
            title={mark.label}
          />
        )}
      </div>
    </div>
  );
}

function ControlSlider({ spec, draft, limits }: { spec: ControlSpec; draft: OperatingConfig; limits: Record<string, number> }) {
  const patch = useApp((s) => s.patchDraft);
  const scale = spec.scale;
  const digits = spec.step * scale >= 1 ? 0 : spec.step * scale >= 0.1 ? 1 : 2;
  const mark = spec.key === "cycles_of_concentration" ? { value: limits.coc_max, label: `Chemistry limit ${limits.coc_max}` } : undefined;
  return (
    <Slider
      label={spec.label}
      unit={spec.unit}
      hint={spec.hint}
      value={Number(draft[spec.key]) * scale}
      min={spec.minimum * scale}
      max={spec.maximum * scale}
      step={spec.step * scale}
      digits={digits}
      mark={mark}
      onChange={(v) => patch({ [spec.key]: Number((v / scale).toFixed(6)) } as Partial<OperatingConfig>)}
    />
  );
}

function Parameters() {
  const overview = useApp((s) => s.overview)!;
  const draft = useApp((s) => s.draft)!;
  const ambientMode = useApp((s) => s.ambientMode);
  const manual = useApp((s) => s.manual);
  const setAmbientMode = useApp((s) => s.setAmbientMode);
  const setManual = useApp((s) => s.setManual);
  const patch = useApp((s) => s.patchDraft);
  const loadDraft = useApp((s) => s.loadDraft);
  const sim = useApp((s) => s.sim);
  const hasWeather = overview.weather.hourly.length > 0;
  const controls = overview.controls;
  const spec = (key: string) => controls.find((c) => c.key === key)!;
  const limits = overview.facility.limits;
  const conditions = sim?.now.conditions;

  useEffect(() => {
    if (!hasWeather && ambientMode === "forecast") setAmbientMode("manual");
  }, [hasWeather, ambientMode, setAmbientMode]);

  return (
    <>
      <Section title="Ambient conditions">
        <Choice
          value={ambientMode}
          onChange={(mode) => (mode === "forecast" && !hasWeather ? undefined : setAmbientMode(mode))}
          options={[
            { value: "forecast", label: "Forecast", title: hasWeather ? "Follow the weather forecast hour by hour" : "No weather data available" },
            { value: "manual", label: "Manual", title: "Hold one ambient condition for the whole window" },
          ]}
        />
        <div className="mt-3 space-y-2.5">
          <Slider
            label="Dry-bulb temperature"
            unit="°C"
            value={ambientMode === "manual" ? manual.t_db_c : (conditions?.t_db_c ?? manual.t_db_c)}
            min={5}
            max={52}
            step={0.5}
            digits={1}
            disabled={ambientMode !== "manual"}
            onChange={(v) => setManual({ t_db_c: v })}
          />
          <Slider
            label="Relative humidity"
            unit="%"
            value={ambientMode === "manual" ? manual.rh_pct : (conditions?.rh_pct ?? manual.rh_pct)}
            min={5}
            max={100}
            step={1}
            digits={0}
            disabled={ambientMode !== "manual"}
            onChange={(v) => setManual({ rh_pct: v })}
          />
        </div>
        {ambientMode === "manual" && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {AMBIENT_CASES.map((c) => (
              <button
                key={c.label}
                onClick={() => setManual({ t_db_c: c.t, rh_pct: c.rh })}
                title={`${c.t} °C, ${c.rh} % humidity`}
                className={`h-[22px] border px-2 text-[11px] leading-none transition-colors ${
                  manual.t_db_c === c.t && manual.rh_pct === c.rh ? "border-accent text-ink" : "border-line-2 text-ink-2 hover:border-ink-3 hover:text-ink"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        <div className="mt-2.5 flex items-baseline justify-between border-t border-line pt-2 text-[11.5px]">
          <span className="text-ink-3">{ambientMode === "manual" ? "Resulting wet-bulb" : "Wet-bulb this hour"}</span>
          <span className="num text-accent">{num(conditions?.t_wb_c, 1)} °C</span>
        </div>
        {ambientMode === "forecast" && (
          <div className="mt-1.5 text-[11px] leading-snug text-ink-3">
            Following the {overview.weather.synthetic ? "synthetic demo profile" : "Meteomatics forecast"}. Switch to manual to test a fixed condition.
          </div>
        )}
      </Section>

      <Section title="Load and water availability">
        <div className="space-y-2.5">
          <ControlSlider spec={spec("it_load_kw")} draft={draft} limits={limits} />
          <ControlSlider spec={spec("water_allocation_m3_day")} draft={draft} limits={limits} />
        </div>
      </Section>

      <Section title="Cooling configuration">
        <div className="space-y-2.5">
          <ControlSlider spec={spec("wet_fraction")} draft={draft} limits={limits} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11.5px] text-ink-2" title={spec("tower_cells_online").hint}>
              Tower cells in service
            </span>
            <Choice
              size="sm"
              value={draft.tower_cells_online}
              onChange={(v) => patch({ tower_cells_online: v })}
              options={[1, 2, 3, 4, 5].map((v) => ({ value: v, label: String(v) }))}
            />
          </div>
        </div>
      </Section>

      <Section title="Set points">
        <div className="space-y-2.5">
          <ControlSlider spec={spec("chw_supply_c")} draft={draft} limits={limits} />
          <ControlSlider spec={spec("tower_fan_speed")} draft={draft} limits={limits} />
          <ControlSlider spec={spec("cw_pump_speed")} draft={draft} limits={limits} />
          <ControlSlider spec={spec("cycles_of_concentration")} draft={draft} limits={limits} />
        </div>
        <div className="mt-3 flex justify-end">
          <Btn kind="quiet" onClick={() => loadDraft(overview.config)} title="Discard the draft and return to the applied configuration">
            Reset to applied
          </Btn>
        </div>
      </Section>
    </>
  );
}

// --- comparison table ----------------------------------------------------------------------
type Row = { label: string; unit?: string; digits: number; get: (s: Scenario) => number | null; delta?: (s: Scenario) => number | null | undefined; rule?: boolean };

const ROWS: Row[] = [
  { label: "Makeup water", unit: "m³", digits: 0, get: (s) => s.summary.makeup_m3, delta: (s) => s.deltas?.makeup_pct },
  { label: "Evaporation", unit: "m³", digits: 0, get: (s) => s.summary.evaporation_m3 },
  { label: "Blowdown", unit: "m³", digits: 0, get: (s) => s.summary.blowdown_m3 },
  { label: "Drift", unit: "m³", digits: 2, get: (s) => s.summary.drift_m3 },
  { label: "Cooling energy", unit: "MWh", digits: 1, get: (s) => s.summary.cooling_energy_kwh / 1000, delta: (s) => s.deltas?.energy_pct, rule: true },
  { label: "Peak cooling power", unit: "kW", digits: 0, get: (s) => s.summary.peak_power_kw },
  { label: "Water use effectiveness", unit: "L/kWh", digits: 2, get: (s) => s.summary.avg_wue_l_kwh },
  { label: "Partial PUE", digits: 3, get: (s) => s.summary.avg_ppue },
  { label: "Peak condenser water", unit: "°C", digits: 1, get: (s) => s.summary.max_cws_c, rule: true },
  { label: "Lowest capacity margin", unit: "kW", digits: 0, get: (s) => s.summary.min_capacity_margin_kw },
  { label: "Lowest tank level", unit: "%", digits: 0, get: (s) => s.summary.min_tank_level_pct },
  { label: "Water allocation used", unit: "%", digits: 0, get: (s) => (s.summary.allocation_utilisation === null ? null : s.summary.allocation_utilisation * 100) },
];

function ScenarioTable({ scenarios, recommended, controls, onApprove }: { scenarios: Scenario[]; recommended: string | null; controls: ControlSpec[]; onApprove: (s: Scenario) => void }) {
  const loadDraft = useApp((s) => s.loadDraft);
  const draft = useApp((s) => s.draft)!;
  const base = scenarios[0];
  const load = (s: Scenario) => {
    const next = { ...draft };
    for (const key of SETPOINT_KEYS) next[key] = s.config[key];
    loadDraft(next);
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse">
        <thead>
          <tr>
            <th className="w-[190px]" />
            {scenarios.map((s) => (
              <th key={s.key} className="border-l border-line px-3 pb-2.5 pt-3 text-left align-top font-normal">
                <div className="mb-2 h-[3px] w-full" style={{ background: SCENARIO_COLOUR[s.key] }} />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] text-ink">{s.label}</span>
                  {s.key === recommended && s.key !== "baseline" && <Tag colour="var(--color-accent)">Recommended</Tag>}
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <Tag colour={s.feasible ? "var(--color-teal)" : "var(--color-crit)"}>{s.feasible ? "Within limits" : "Breaks a limit"}</Tag>
                </div>
                <div className="mt-2 flex gap-1.5">
                  {s.key !== "draft" && (
                    <Btn kind="ghost" className="h-6 px-2 text-[11px]" onClick={() => load(s)} title="Copy these set points into the draft">
                      Load into draft
                    </Btn>
                  )}
                  {s.key !== "baseline" && (
                    <Btn kind={s.key === "draft" ? "primary" : "ghost"} className="h-6 px-2 text-[11px]" onClick={() => onApprove(s)} disabled={s.key === "draft" && s.changes.length === 0}>
                      Approve…
                    </Btn>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.label} className={row.rule ? "border-t border-line-2" : "border-t border-line"}>
              <td className="px-3 py-[5px] text-[11.5px] text-ink-2">
                {row.label}
                {row.unit && <span className="ml-1 text-ink-3">{row.unit}</span>}
              </td>
              {scenarios.map((s) => {
                const d = row.delta?.(s);
                return (
                  <td key={s.key} className="border-l border-line px-3 py-[5px]">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="num text-[12.5px] text-ink">{num(row.get(s), row.digits)}</span>
                      {row.delta && s.key !== "baseline" && (
                        <span className="text-[11px]">
                          <Delta value={d} digits={Math.abs(d ?? 0) < 10 ? 1 : 0} />
                        </span>
                      )}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="border-t border-line-2">
            <td className="label px-3 pb-1 pt-3" colSpan={scenarios.length + 1}>
              Set points
            </td>
          </tr>
          {controls
            .filter((c) => (SETPOINT_KEYS as readonly string[]).includes(c.key))
            .map((c) => (
              <tr key={c.key} className="border-t border-line">
                <td className="px-3 py-[5px] text-[11.5px] text-ink-2">
                  {c.label}
                  {c.unit && <span className="ml-1 text-ink-3">{c.unit}</span>}
                </td>
                {scenarios.map((s) => {
                  const v = Number(s.config[c.key]) * c.scale;
                  const changed = Math.abs(v - Number(base.config[c.key]) * c.scale) > 1e-6;
                  return (
                    <td key={s.key} className="border-l border-line px-3 py-[5px]">
                      <span className={`num text-[12.5px] ${changed ? "text-ink" : "text-ink-3"}`}>{num(v, c.step * c.scale >= 1 ? 0 : 1)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          <tr className="border-t border-line">
            <td className="px-3 py-[5px] text-[11.5px] text-ink-2">Objective value</td>
            {scenarios.map((s) => (
              <td key={s.key} className="border-l border-line px-3 py-[5px]">
                <span className="num text-[12.5px] text-ink">{num(s.objective?.value, 3)}</span>
                {s.objective && (
                  <span className="ml-2 text-[10.5px] text-ink-3">
                    {num(s.objective.w_water * 100, 0)} % water / {num(s.objective.w_energy * 100, 0)} % energy
                  </span>
                )}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ConstraintTable({ rows }: { rows: Constraint[] }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="text-left text-[10.5px] text-ink-3">
          <th className="px-3 py-1.5 font-normal">Constraint, worst hour of the window</th>
          <th className="px-3 py-1.5 text-right font-normal">Value</th>
          <th className="px-3 py-1.5 text-right font-normal">Limit</th>
          <th className="px-3 py-1.5 text-right font-normal">Margin</th>
          <th className="w-[84px] px-3 py-1.5 text-right font-normal">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.id} className="border-t border-line" title={c.detail}>
            <td className="px-3 py-[5px] text-[11.5px] text-ink-2">{c.label}</td>
            <td className="num px-3 py-[5px] text-right text-[12px] text-ink">
              {num(c.value, 1)} <span className="text-ink-3">{c.unit}</span>
            </td>
            <td className="num px-3 py-[5px] text-right text-[12px] text-ink-2">
              {c.kind === "max" ? "≤" : "≥"} {num(c.limit, 1)}
            </td>
            <td className="num px-3 py-[5px] text-right text-[12px]" style={{ color: c.status === "n/a" ? "var(--color-ink-3)" : CHECK_COLOUR[c.status] }}>
              {num(c.margin, 1)}
            </td>
            <td className="px-3 py-[5px] text-right">
              <Tag colour={CHECK_COLOUR[c.status]}>{CHECK_LABEL[c.status]}</Tag>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Simulation() {
  const overview = useApp((s) => s.overview);
  const draft = useApp((s) => s.draft);
  const ambientMode = useApp((s) => s.ambientMode);
  const manual = useApp((s) => s.manual);
  const windowHours = useApp((s) => s.windowHours);
  const setWindowHours = useApp((s) => s.setWindowHours);
  const sim = useApp((s) => s.sim);
  const simStatus = useApp((s) => s.simStatus);
  const simError = useApp((s) => s.simError);
  const simOpt = useApp((s) => s.simOpt);
  const simOptStatus = useApp((s) => s.simOptStatus);
  const simOptError = useApp((s) => s.simOptError);
  const runSimulation = useApp((s) => s.runSimulation);
  const runSimOptimisation = useApp((s) => s.runSimOptimisation);
  const offset = useOffset();
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);

  // Every parameter change recalculates. The simulation is cheap and follows
  // the sliders; the optimisation only depends on the conditions.
  const draftKey = JSON.stringify(draft);
  const ambientKey = ambientMode === "manual" ? `${manual.t_db_c}|${manual.rh_pct}` : "forecast";
  const conditionKey = draft ? CONDITION_KEYS.map((k) => draft[k]).join("|") : "";
  const weatherKey = overview?.weather.fetched_at ?? "";
  const appliedKey = JSON.stringify(overview?.config);
  useEffect(() => {
    if (!draft) return;
    const id = setTimeout(runSimulation, 110);
    return () => clearTimeout(id);
  }, [draftKey, ambientKey, windowHours, weatherKey, appliedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!draft) return;
    const id = setTimeout(runSimOptimisation, 380);
    return () => clearTimeout(id);
  }, [conditionKey, ambientKey, windowHours, weatherKey, appliedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const scenarios = useMemo(() => {
    if (!simOpt) return sim ? [sim.draft] : [];
    const list = [...simOpt.scenarios];
    if (sim && sim.draft.changes.length > 0 && sim.draft.summary.hours === simOpt.window_hours) list.push(sim.draft);
    return list;
  }, [simOpt, sim]);

  if (!overview || !draft) return null;
  const point = sim?.now;
  const times = simOpt?.times ?? [];
  const lines = (pick: (s: Scenario) => (number | null)[]): Series[] =>
    scenarios.map((s) => ({ key: s.key, label: s.label, colour: SCENARIO_COLOUR[s.key], values: pick(s), dashed: s.key === "draft" }));
  const draftScenario = sim?.draft;
  const controls = overview.controls;
  const pending = diffConfig(controls, overview.config, draft);

  const approve = (s: Scenario) => {
    const config = s.key === "draft" ? draft : { ...draft, ...Object.fromEntries(SETPOINT_KEYS.map((k) => [k, s.config[k]])) };
    setApproval({
      title: s.key === "draft" ? "Apply the draft configuration" : `Apply the ${s.label.toLowerCase()} configuration`,
      source: s.key === "draft" ? "simulation draft" : `optimiser: ${s.label.toLowerCase()}`,
      config: config as OperatingConfig,
      changes: diffConfig(controls, overview.config, config as OperatingConfig),
      deltas: s.deltas,
      windowHours: s.summary.hours,
      feasible: s.feasible,
      problems: s.infeasibility,
    });
  };

  const solving = simOptStatus === "loading";
  const blocked = simError && !sim;

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[318px] shrink-0 overflow-y-auto border-r border-line bg-panel">
        <Parameters />
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto bg-panel">
        <div className="flex h-10 items-center justify-between gap-3 border-b border-line px-3">
          <div className="flex items-baseline gap-2.5">
            <span className="label">Scenario comparison</span>
            <span className="text-[11px] text-ink-3">
              {ambientMode === "manual" ? "manual ambient held for the window" : overview.weather.synthetic ? "synthetic demo profile" : "Meteomatics forecast"}
            </span>
            {solving && <span className="label pulse text-accent">Solving</span>}
            {simStatus === "loading" && !solving && <span className="label pulse">Recalculating</span>}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-ink-3">Window</span>
            <Choice size="sm" value={windowHours} onChange={setWindowHours} options={[24, 48, 72].map((h) => ({ value: h, label: `${h} h` }))} />
          </div>
        </div>

        {blocked && (
          <div className="p-3">
            <Note tone="crit">{simError} Switch the ambient to manual to simulate without weather data.</Note>
          </div>
        )}
        {simOptStatus === "error" && !blocked && (
          <div className="p-3">
            <Note tone="warn">{simOptError}</Note>
          </div>
        )}

        {scenarios.length > 0 ? (
          <div className={`transition-opacity ${solving ? "opacity-60" : ""}`}>
            <ScenarioTable scenarios={scenarios} recommended={simOpt?.recommended ?? null} controls={controls} onApprove={approve} />
            {simOpt && (
              <div className="border-t border-line px-3 py-2.5 text-[11.5px] leading-snug text-ink-2">
                <span className="text-ink-3">Optimiser: </span>
                {simOpt.recommendation_reason}{" "}
                <span className="text-ink-3">
                  {simOpt.scenarios
                    .slice(1)
                    .map((s) => `${s.label}: ${s.solver.message} (${s.solver.evaluations} model evaluations, ${num(s.solver.runtime_ms, 0)} ms).`)
                    .join(" ")}
                </span>
              </div>
            )}
            {scenarios.some((s) => s.infeasibility.length > 0) && (
              <div className="space-y-2 border-t border-line p-3">
                {scenarios
                  .filter((s) => s.infeasibility.length > 0)
                  .map((s) => (
                    <Note key={s.key} tone="crit">
                      <span className="text-ink">{s.label}: </span>
                      {s.infeasibility.join(" ")}
                    </Note>
                  ))}
              </div>
            )}

            {times.length > 0 && (
              <div className="grid grid-cols-1 gap-x-6 gap-y-5 border-t border-line p-3 2xl:grid-cols-2">
                <TimeChart title="Makeup water by hour" unit="m³/h" times={times} offset={offset} height={170} series={lines((s) => s.hourly_makeup_m3_h)} zero />
                <TimeChart title="Cooling power by hour" unit="kW" times={times} offset={offset} height={170} digits={0} series={lines((s) => s.hourly_power_kw)} />
                {simOpt && (
                  <TradeoffChart
                    curve={simOpt.tradeoff.map((p) => ({ water: p.makeup_m3, energy: p.energy_kwh, feasible: p.feasible, share: p.wet_fraction }))}
                    points={scenarios.map((s) => ({
                      key: s.key,
                      label: s.label,
                      colour: SCENARIO_COLOUR[s.key],
                      water: s.summary.makeup_m3,
                      energy: s.summary.cooling_energy_kwh,
                      feasible: s.feasible,
                      hollow: s.key === "draft",
                    }))}
                  />
                )}
                <TimeChart
                  title="Stored water"
                  unit="% of tank"
                  times={times}
                  offset={offset}
                  height={210}
                  digits={0}
                  series={lines((s) => s.hourly_tank_level_pct)}
                  refs={[{ value: overview.facility.limits.tank_reserve_pct, label: "Reserve" }]}
                />
              </div>
            )}

            {draftScenario && (
              <div className="border-t border-line">
                <div className="flex h-8 items-center justify-between px-3">
                  <span className="label">Constraints for the {draftScenario.changes.length ? "draft" : "current configuration"}</span>
                  <span className="text-[11px] text-ink-3">Hover a row for the reason behind each limit</span>
                </div>
                <ConstraintTable rows={draftScenario.constraints} />
              </div>
            )}
          </div>
        ) : (
          !blocked && (
            <div className="p-3">
              <Skeleton lines={6} />
            </div>
          )
        )}
      </div>

      <aside className="w-[328px] shrink-0 overflow-y-auto border-l border-line bg-panel">
        <TwinSlot className="relative h-[224px] border-b border-line">
          <div className="pointer-events-none absolute left-2.5 top-2.5 z-[2]">
            <Tag colour="var(--color-s2)">Draft preview, not applied</Tag>
          </div>
        </TwinSlot>
        {point ? (
          <>
            <Section title="Operating point, this hour" right={<Tag>Simulated</Tag>}>
              <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
                <Stat label="Makeup water" value={point.water.makeup_m3_h} unit="m³/h" sub={`evaporation ${num(point.water.evaporation_m3_h, 1)}, blowdown ${num(point.water.blowdown_m3_h, 1)}, drift ${num(point.water.drift_m3_h, 2)}`} />
                <Stat label="Cooling power" value={point.energy.cooling_power_kw} unit="kW" digits={0} sub={`partial PUE ${num(point.energy.ppue, 3)}`} />
                <Stat label="Heat rejection" value={point.thermal.heat_rejection_kw} unit="kW" digits={0} sub={`towers ${num(point.thermal.heat_rejection_wet_kw, 0)}, dry ${num(point.thermal.heat_rejection_dry_kw, 0)}`} />
                <Stat
                  label="Cooling capacity"
                  value={point.capacity.cooling_capacity_kw}
                  unit="kW"
                  digits={0}
                  sub={`${num(point.capacity.margin_kw, 0)} kW above the load`}
                  tone={point.capacity.margin_kw < 0 ? "var(--color-crit)" : undefined}
                />
                <Stat label="Condenser water" value={point.thermal.cws_c} unit="°C" sub={`approach ${num(point.thermal.approach_k, 1)} K, range ${num(point.thermal.range_k, 1)} K`} />
                <Stat label="Latent fraction" value={point.thermal.latent_fraction} digits={2} sub="evaporation heat / heat rejected" />
                <Stat label="Chiller COP" value={point.thermal.wc_cop} digits={2} sub={point.thermal.ac_cop ? `air-cooled ${num(point.thermal.ac_cop, 2)}` : "dry plant idle"} />
                <Stat label="Server inlet" value={point.thermal.server_inlet_c} unit="°C" sub={`limit ${num(overview.facility.limits.server_inlet_limit_c, 0)} °C`} />
              </div>
            </Section>
            {point.warnings.length > 0 && (
              <Section title="Model notes">
                <ul className="space-y-1.5">
                  {point.warnings.map((w) => (
                    <li key={w} className="flex gap-2 text-[11.5px] leading-snug text-ink-2">
                      <Icon name={point.feasible ? "info" : "alert"} size={12} className={`mt-[2px] shrink-0 ${point.feasible ? "text-ink-3" : "text-crit"}`} />
                      {w}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            <Section title="Apply">
              <p className="text-[11.5px] leading-snug text-ink-2">
                {pending.length
                  ? `The draft changes ${pending.length} value${pending.length > 1 ? "s" : ""} of the applied configuration. Nothing is applied until an operator approves it.`
                  : "The draft matches the applied configuration. Move a slider or load a scenario to compare."}
              </p>
              <Btn
                kind="primary"
                className="mt-3 w-full"
                disabled={!draftScenario || pending.length === 0}
                onClick={() => draftScenario && approve(draftScenario)}
              >
                <Icon name="lock" size={12} />
                Review and approve draft
              </Btn>
            </Section>
          </>
        ) : (
          <div className="p-3">{blocked ? null : <Skeleton lines={5} />}</div>
        )}
      </aside>

      {approval && <ApprovalDialog request={approval} onClose={() => setApproval(null)} />}
    </div>
  );
}
