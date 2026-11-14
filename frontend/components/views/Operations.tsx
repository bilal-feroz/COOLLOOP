"use client";

import { clock, dayClock, fullClock, num } from "@/lib/format";
import { useApp, useOffset } from "@/lib/store";
import type { Alert, Overview } from "@/lib/types";
import { StressLegend, StressStrip, TimeChart } from "../charts";
import { CameraPresets, Inspector, LayerControls } from "../twin/Controls";
import { TwinSlot } from "../twin/TwinViewport";
import { Btn, Delta, Dot, Icon, LEVEL_COLOUR, LEVEL_LABEL, Meter, Note, Section, Segments, Skeleton, Stat, Tag } from "../ui";

function Environment({ overview }: { overview: Overview }) {
  const weather = overview.weather;
  const offset = weather.location.utc_offset_hours;
  const setWeatherMode = useApp((s) => s.setWeatherMode);
  const refreshWeather = useApp((s) => s.refreshWeather);
  const busy = useApp((s) => s.busy);
  const now = weather.current;
  const ahead = weather.hourly.slice(0, 72);
  const past = weather.history.slice(-24);
  const hours = [...past, ...ahead];
  const times = hours.map((h) => h.time);
  const marker = past.length ? { index: past.length, label: "now" } : undefined;
  const rain = ahead.reduce((a, h) => a + (h.precip_mm ?? 0), 0);
  const design = overview.facility.limits.tower_design_wet_bulb_c;
  const projection = overview.projection;
  const demandBands = projection
    ? projection.periods
        .filter((p) => p.kind === "water")
        .map((p) => {
          const from = projection.times.indexOf(p.start);
          return { from, to: from + p.hours - 1 };
        })
        .filter((b) => b.from >= 0)
    : [];

  if (!now) {
    return (
      <Section title="Environment" right={<span className="text-[11px] text-ink-3">{weather.location.name}</span>}>
        <div className="space-y-2.5">
          <Note tone="crit">{weather.error?.message ?? "No weather data is available."}</Note>
          <p className="text-[11.5px] leading-snug text-ink-3">
            The simulation follows the forecast, so nothing is projected until weather data arrives. No substitute data is shown.
          </p>
          <div className="flex gap-2">
            <Btn onClick={refreshWeather} disabled={busy}>
              <Icon name="refresh" size={12} />
              Retry
            </Btn>
            {weather.mode === "replay" && (
              <Btn onClick={() => setWeatherMode("live")} disabled={busy} title="Leave the replay and follow the live forecast">
                Back to live
              </Btn>
            )}
            <Btn onClick={() => setWeatherMode("demo")} disabled={busy} title="Use the labelled synthetic dataset">
              Use demo dataset
            </Btn>
          </div>
        </div>
      </Section>
    );
  }

  return (
    <>
      <Section
        title="Environment"
        right={
          <span className="flex items-center gap-2">
            {weather.synthetic && <Tag colour="var(--color-warn)">Synthetic</Tag>}
            {weather.status === "cached" && <Tag colour="var(--color-warn)">Cached</Tag>}
            {weather.status === "replay" && <Tag colour="var(--color-warn)">Replay</Tag>}
            <span className="text-[11px] text-ink-3">{weather.location.name}</span>
          </span>
        }
      >
        <div className="grid grid-cols-3 gap-x-3 gap-y-3.5">
          <Stat label="Dry-bulb" value={now.t_2m_c} unit="°C" />
          <Stat label="Wet-bulb" value={now.wet_bulb_c} unit="°C" tone="var(--color-accent)" />
          <Stat label="Humidity" value={now.rh_pct} unit="%" digits={0} />
          <Stat label="Wind" value={now.wind_ms} unit="m/s" size="sm" />
          <Stat label="Radiation" value={now.global_rad_w_m2} unit="W/m²" digits={0} size="sm" />
          <Stat label="Pressure" value={now.pressure_hpa} unit="hPa" digits={0} size="sm" />
        </div>
        <div className="mt-3 text-[11px] leading-snug text-ink-3">
          Valid {weather.status === "replay" ? fullClock(now.time, offset) : dayClock(now.time, offset)}. {weather.provider}
          {weather.model && !weather.synthetic ? `, source ${weather.model}` : ""}.
          {weather.wet_bulb_source === "derived" ? " Wet-bulb derived from temperature and humidity." : ""}
        </div>
      </Section>

      <Section title={past.length ? `Weather, last ${past.length} h and next 72 h` : "Weather, next 72 h"}>
        <div className="space-y-4">
          <TimeChart
            title="Temperature"
            unit="°C"
            times={times}
            offset={offset}
            height={136}
            series={[
              { key: "db", label: "Dry-bulb", colour: "var(--color-s2)", values: hours.map((h) => h.t_2m_c) },
              { key: "wb", label: "Wet-bulb", colour: "var(--color-s1)", values: hours.map((h) => h.wet_bulb_c) },
            ]}
            refs={[{ value: design, label: `Tower design wet-bulb ${num(design, 0)} °C` }]}
            marker={marker}
          />
          <TimeChart
            title="Relative humidity"
            unit="%"
            times={times}
            offset={offset}
            height={92}
            digits={0}
            series={[{ key: "rh", label: "Humidity", colour: "var(--color-s3)", values: hours.map((h) => h.rh_pct), area: true }]}
            marker={marker}
          />
          {rain > 0.05 ? (
            <TimeChart
              title="Precipitation"
              unit="mm/h"
              times={ahead.map((h) => h.time)}
              offset={offset}
              height={84}
              digits={2}
              series={[{ key: "rain", label: "Rain", colour: "var(--color-s1)", values: ahead.map((h) => h.precip_mm), kind: "bar" }]}
            />
          ) : (
            <div>
              <div className="mb-1 text-[12px] text-ink">Precipitation</div>
              <div className="border border-line bg-inset px-2.5 py-2 text-[11.5px] text-ink-3">No rain in the next 72 hours.</div>
            </div>
          )}
        </div>
      </Section>

      {projection && (
        <Section title="Projected plant response" right={<Tag>Simulated</Tag>}>
          <div className="space-y-4">
            <TimeChart
              title="Makeup water"
              unit="m³/h"
              times={projection.times}
              offset={offset}
              height={112}
              zero
              series={[{ key: "makeup", label: "Makeup", colour: "var(--color-s1)", values: projection.makeup_m3_h, area: true }]}
              refs={[{ value: overview.config.water_allocation_m3_day / 24, label: "Allocation rate" }]}
              bands={demandBands}
            />
            <TimeChart
              title="Cooling power"
              unit="kW"
              times={projection.times}
              offset={offset}
              height={104}
              digits={0}
              series={[{ key: "power", label: "Cooling power", colour: "var(--color-s2)", values: projection.cooling_power_kw }]}
            />
          </div>
          <p className="mt-2.5 text-[11px] leading-snug text-ink-3">
            The applied configuration held for every hour ahead.
            {demandBands.length > 0 ? " Shaded hours are the periods of highest water demand." : ""}
          </p>
        </Section>
      )}
    </>
  );
}

function Alerts({ alerts, offset }: { alerts: Alert[]; offset: number }) {
  const colour = { critical: "var(--color-crit)", warning: "var(--color-warn)", info: "var(--color-ink-3)" };
  return (
    <Section title="Alerts" right={<span className="num text-[11px] text-ink-3">{alerts.length}</span>} pad={false}>
      {alerts.length === 0 && <div className="px-3 pb-3 text-[11.5px] text-ink-3">No active alerts.</div>}
      <ul>
        {alerts.map((a) => (
          <li key={a.id} className="flex gap-2.5 border-t border-line px-3 py-2">
            <span className="mt-[5px] h-[7px] w-[7px] shrink-0" style={{ background: colour[a.severity] }} />
            <div className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] text-ink">{a.title}</span>
                {a.time && <span className="num shrink-0 text-[10.5px] text-ink-3">{dayClock(a.time, offset)}</span>}
              </div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-ink-2">{a.detail}</div>
              <div className="mt-0.5 text-[10.5px] text-ink-3">{a.source}</div>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function RecommendationCard() {
  const optimisation = useApp((s) => s.optimisation);
  const status = useApp((s) => s.optimisationStatus);
  const error = useApp((s) => s.optimisationError);
  const setView = useApp((s) => s.setView);
  const chosen = optimisation?.scenarios.find((s) => s.key === optimisation.recommended);
  return (
    <Section title="Recommendation" right={<Tag>Needs approval</Tag>}>
      {status === "loading" && !optimisation && <Skeleton lines={4} />}
      {status === "error" && <Note tone="warn">{error ?? "No optimisation available."}</Note>}
      {optimisation && chosen && (
        <div className="rise">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] text-ink">
              {chosen.key === "baseline" ? "Keep the current configuration" : `${chosen.label} configuration`}
            </span>
            <span className="num text-[10.5px] text-ink-3">next {optimisation.window_hours} h</span>
          </div>
          {chosen.deltas && (
            <div className="mt-2.5 grid grid-cols-2 gap-3 border-y border-line py-2.5">
              <div>
                <div className="label mb-1.5">Makeup water</div>
                <div className="text-[15px]">
                  <Delta value={chosen.deltas.makeup_pct} digits={0} />
                </div>
                <div className="num mt-1 text-[11px] text-ink-3">{num(chosen.summary.makeup_m3, 0)} m³</div>
              </div>
              <div>
                <div className="label mb-1.5">Cooling energy</div>
                <div className="text-[15px]">
                  <Delta value={chosen.deltas.energy_pct} digits={1} />
                </div>
                <div className="num mt-1 text-[11px] text-ink-3">{num(chosen.summary.cooling_energy_kwh / 1000, 1)} MWh</div>
              </div>
            </div>
          )}
          <p className="mt-2.5 text-[11.5px] leading-snug text-ink-2">{optimisation.recommendation_reason}</p>
          <div className="mt-3 flex gap-2">
            <Btn kind="primary" onClick={() => setView("intelligence")}>
              Review
            </Btn>
            <Btn onClick={() => setView("simulation")}>Compare scenarios</Btn>
          </div>
        </div>
      )}
    </Section>
  );
}

function Plant({ overview }: { overview: Overview }) {
  const point = overview.now;
  const projection = overview.projection;
  const demandBands = projection
    ? projection.periods
        .filter((p) => p.kind === "water")
        .map((p) => {
          const from = projection.times.indexOf(p.start);
          return { from, to: from + p.hours - 1 };
        })
        .filter((b) => b.from >= 0)
    : [];
  const offset = overview.weather.location.utc_offset_hours;
  if (!point || !projection) {
    return (
      <>
        <Section title="Plant">
          <Note tone="warn">No simulation without weather data. Open Simulation to run with a manual ambient condition.</Note>
        </Section>
        <Alerts alerts={overview.alerts} offset={offset} />
      </>
    );
  }
  const { water, energy, thermal, capacity } = point;
  const day = projection.day;
  const limits = overview.facility.limits;
  const chillers = energy.wc_chiller_kw + energy.ac_chiller_kw;
  const fans = energy.tower_fan_kw + energy.ac_fan_kw + energy.crah_fan_kw;
  const pumps = energy.cw_pump_kw + energy.chw_pump_kw;
  return (
    <>
      <Section title="Water" right={<Tag>Simulated</Tag>}>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Makeup now" value={water.makeup_m3_h} unit="m³/h" size="lg" sub={`${num(water.makeup_m3_day, 0)} m³/day at this rate`} />
          <div>
            <Stat label="Next 24 h" value={day.makeup_m3} unit="m³" digits={0} />
            <div className="mt-2">
              <Meter value={day.allocation_utilisation} label="Share of the water allocation" />
            </div>
            <div className="mt-1.5 text-[11px] text-ink-3">
              <span className="num text-ink-2">{num((day.allocation_utilisation ?? 0) * 100, 0)} %</span> of {num(day.allocation_m3, 0)} m³ allocation
            </div>
          </div>
        </div>
        <div className="mt-3.5">
          <Segments
            unit="m³/h"
            digits={2}
            parts={[
              { label: "Evaporation", value: water.evaporation_m3_h, colour: "var(--color-s1)" },
              { label: "Blowdown", value: water.blowdown_m3_h, colour: "var(--color-s2)" },
              { label: "Drift", value: water.drift_m3_h, colour: "var(--color-s3)" },
            ]}
          />
        </div>
        <div className="mt-3.5 grid grid-cols-3 gap-3 border-t border-line pt-3">
          <Stat label="WUE" value={water.wue_l_kwh} unit="L/kWh" digits={2} size="sm" />
          <Stat label="Cycles" value={water.cycles_of_concentration} digits={1} size="sm" />
          <Stat
            label="Tank"
            value={water.tank_level_pct}
            unit="%"
            digits={0}
            size="sm"
            sub={water.autonomy_h ? `${num(water.autonomy_h, 0)} h autonomy` : undefined}
          />
        </div>
      </Section>

      <Section title="Cooling" right={<Tag>Simulated</Tag>}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
          <Stat label="Cooling load" value={thermal.cooling_load_kw} unit="kW" digits={0} sub={`IT ${num(thermal.it_load_kw / 1000, 2)} MW`} />
          <Stat label="Heat rejection" value={thermal.heat_rejection_kw} unit="kW" digits={0} sub={`${num(thermal.wet_fraction * 100, 0)} % evaporative`} />
          <Stat label="Cooling power" value={energy.cooling_power_kw} unit="kW" digits={0} sub={`${num(day.cooling_energy_kwh / 1000, 1)} MWh next 24 h`} />
          <Stat label="Partial PUE" value={energy.ppue} digits={3} sub={`${num(energy.kw_per_kw_cooling, 3)} kW per kW cooling`} />
        </div>
        <div className="mt-3.5">
          <Segments
            unit="kW"
            digits={0}
            parts={[
              { label: "Chillers", value: chillers, colour: "var(--color-s1)" },
              { label: "Fans", value: fans, colour: "var(--color-s2)" },
              { label: "Pumps", value: pumps, colour: "var(--color-s3)" },
            ]}
          />
        </div>
        <div className="mt-3.5 grid grid-cols-3 gap-3 border-t border-line pt-3">
          <Stat
            label="Cond. water"
            value={thermal.cws_c}
            unit="°C"
            size="sm"
            sub={`limit ${num(limits.cws_max_c, 0)} °C`}
            tone={thermal.cws_c !== null && thermal.cws_c > limits.cws_max_c - 1 ? "var(--color-warn)" : undefined}
          />
          <Stat label="Approach" value={thermal.approach_k} unit="K" size="sm" sub={`range ${num(thermal.range_k, 1)} K`} />
          <Stat label="Headroom" value={capacity.margin_kw} unit="kW" digits={0} size="sm" sub={`${num(capacity.utilisation * 100, 0)} % used`} />
        </div>
      </Section>

      <Alerts alerts={overview.alerts} offset={offset} />
      <RecommendationCard />
    </>
  );
}

function StatusOverlay({ overview }: { overview: Overview }) {
  const point = overview.now;
  const offset = useOffset();
  if (!point) return null;
  const stress = point.stress;
  const meta = overview.config_meta;
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-[2]">
      <div className="border border-line-2 bg-[#0a0d10d9] px-3 py-2.5 backdrop-blur-[2px]">
        <div className="label mb-2">Cooling stress now</div>
        <div className="flex items-center gap-2.5">
          <Dot colour={LEVEL_COLOUR[stress.level]} size={9} pulse={stress.level === "critical"} />
          <span className="text-[15px] font-medium text-ink">{LEVEL_LABEL[stress.level]}</span>
          <span className="num text-[13px] text-ink-2">{num(stress.index, 2)}</span>
        </div>
        <div className="mt-1.5 text-[11px] text-ink-3">Driver: {stress.driver.toLowerCase()}</div>
      </div>
      <div className="mt-1.5 text-[10.5px] text-ink-3">
        Configuration: {meta.source}
        {meta.applied_at ? `, applied ${clock(meta.applied_at, offset)}` : ""}
      </div>
    </div>
  );
}

export default function Operations() {
  const overview = useApp((s) => s.overview);
  const selected = useApp((s) => s.selected);
  const select = useApp((s) => s.select);
  const setView = useApp((s) => s.setView);
  const offset = useOffset();
  if (!overview) return null;
  const projection = overview.projection;
  const demandBands = projection
    ? projection.periods
        .filter((p) => p.kind === "water")
        .map((p) => {
          const from = projection.times.indexOf(p.start);
          return { from, to: from + p.hours - 1 };
        })
        .filter((b) => b.from >= 0)
    : [];
  const item = overview.now?.equipment.find((e) => e.id === selected);

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[312px] shrink-0 overflow-y-auto border-r border-line bg-panel">
        <Environment overview={overview} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TwinSlot className="relative min-h-0 flex-1">
          <StatusOverlay overview={overview} />
          <div className="absolute right-3 top-3 z-[2] flex flex-col items-end gap-2">
            <CameraPresets />
            <div className="border border-line-2 bg-[#0a0d10d9] px-2.5 py-1.5">
              <LayerControls />
            </div>
          </div>
          {item && (
            <div className="rise absolute bottom-3 left-3 z-[2] w-[264px] border border-line-2 bg-[#0c0f12f2] p-3">
              <Inspector item={item} onClose={() => select(null)} />
              <button onClick={() => setView("twin")} className="mt-2 flex items-center gap-1 text-[11px] text-accent hover:underline">
                Open in digital twin <Icon name="chevron" size={10} />
              </button>
            </div>
          )}
          {!item && (
            <div className="pointer-events-none absolute bottom-3 left-3 z-[2] text-[10.5px] text-ink-3">
              Drag to orbit, right-drag to pan, scroll to zoom. Click equipment to inspect it.
            </div>
          )}
        </TwinSlot>

        {projection && (
          <div className="shrink-0 border-t border-line bg-panel px-3 pb-2 pt-2">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-baseline gap-2">
                <span className="label">Cooling stress, next {projection.horizon.hours} h</span>
                <span className="text-[11px] text-ink-3">
                  peak {num(projection.horizon.max_stress, 2)} on {dayClock(projection.horizon.max_stress_time, offset)}
                </span>
              </div>
              <StressLegend />
            </div>
            <StressStrip times={projection.times} offset={offset} values={projection.stress} levels={projection.stress_level} drivers={projection.stress_driver} />
          </div>
        )}
      </div>

      <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-line bg-panel">
        <Plant overview={overview} />
      </aside>
    </div>
  );
}
