"use client";

// The landing screen. It tells one story, readable at a glance:
//   the weather outside  ->  the water the cooling needs  ->  how to use less.
// Detail lives in the other sections: equipment in Digital twin, every
// variable and scenario in Simulation, the reasoning in Intelligence.

import { useState } from "react";
import { dayClock, dayLabel, localHour, num, signed } from "@/lib/format";
import { useApp, useOffset } from "@/lib/store";
import type { Alert, Overview, Projection } from "@/lib/types";
import { ApprovalDialog, type ApprovalRequest, diffConfig } from "../Approval";
import { useWidth } from "../charts";
import { Inspector } from "../twin/Controls";
import { TwinSlot } from "../twin/TwinViewport";
import { Btn, Icon, LEVEL_COLOUR, LEVEL_LABEL, Note, Skeleton } from "../ui";

const SOURCE: Record<string, string> = {
  live: "live Meteomatics weather",
  cached: "last Meteomatics forecast",
  replay: "replayed Meteomatics weather",
  demo: "synthetic demo weather",
};

// --- the black column: headline, twin, timeline -------------------------------------

function Headline({ overview }: { overview: Overview }) {
  const { now, weather, config } = overview;
  const facts = [weather.location.name, `simulated ${num(config.it_load_kw / 1000, 0)} MW data centre`, SOURCE[weather.status] ?? "no weather data"];
  const replay = weather.status === "replay";
  return (
    <header className="shrink-0 px-6 pb-4 pt-5">
      <div className="text-[12px] text-ink-3">{facts.join("  ·  ")}</div>
      {now ? (
        <>
          <h1 className="mt-2 max-w-[660px] text-[29px] font-medium leading-[1.13] tracking-[-0.02em] text-ink-2">
            Keeping this data centre cool takes <span className="text-ink">{num(now.water.makeup_m3_h, 1)} m³ of water</span> an hour.
          </h1>
          <p className="mt-2.5 max-w-[640px] text-[13px] leading-relaxed text-ink-3">
            {now.water.makeup_m3_h > 0.05
              ? `Its cooling towers evaporate water to carry ${num(now.thermal.heat_rejection_wet_kw / 1000, 1)} MW of heat into ${num(now.conditions.t_db_c, 0)} °C air. `
              : `All heat goes to the dry coolers, so no water evaporates. `}
            COOLLOOP follows the {replay ? "replayed weather" : "forecast"} hour by hour and finds settings that use less.
          </p>
        </>
      ) : (
        <h1 className="mt-2 max-w-[660px] text-[29px] font-medium leading-[1.13] tracking-[-0.02em] text-ink-2">
          No weather data yet, so nothing is simulated.
        </h1>
      )}
    </header>
  );
}

/** Air temperature and water demand on one time axis: the hot, dry hours and
 *  the thirsty hours line up, which is the whole idea in one picture. */
function Timeline({ projection, offset, design }: { projection: Projection; offset: number; design: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const times = projection.times;
  const n = times.length;
  const water = projection.makeup_m3_h;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * width : 0);

  // Row 1: air. Row 2: water. A stress tick row under them.
  const air = { top: 18, h: 58 };
  const wat = { top: 100, h: 62 };
  const stressY = wat.top + wat.h + 6;
  const total = stressY + 22;

  const tLo = Math.floor(Math.min(...projection.t_wb_c) - 0.5);
  const tHi = Math.ceil(Math.max(...projection.t_db_c, design) + 0.5);
  const yAir = (v: number) => air.top + air.h - ((v - tLo) / Math.max(1, tHi - tLo)) * air.h;
  // Water is a line on its own range, not an area from zero: the hourly swing
  // is the point. The allowance is shown against the daily total in the rail.
  const wLo = Math.min(...water);
  const wHi = Math.max(...water);
  const wPad = Math.max(0.5, (wHi - wLo) * 0.12);
  const yWat = (v: number) => wat.top + wat.h - ((v - (wLo - wPad)) / Math.max(1e-6, wHi - wLo + 2 * wPad)) * wat.h;
  const path = (vals: number[], y: (v: number) => number) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const waterLine = path(water, yWat);

  const bands = projection.periods
    .filter((p) => p.kind === "water")
    .map((p) => ({ p, from: times.indexOf(p.start) }))
    .filter((b) => b.from >= 0);
  const peakBand = bands.reduce<(typeof bands)[number] | null>((best, b) => (!best || b.p.peak > best.p.peak ? b : best), null);
  const peakAt = peakBand ? peakBand.from + water.slice(peakBand.from, peakBand.from + peakBand.p.hours).indexOf(Math.max(...water.slice(peakBand.from, peakBand.from + peakBand.p.hours))) : -1;
  const stressed = projection.stress_level.some((l) => l !== "nominal");
  const days = times.map((t, i) => ({ t, i })).filter(({ t, i }) => i > 0 && localHour(t, offset) === 0);
  const h = hover;

  return (
    <div className="shrink-0 border-t border-line px-6 pb-3 pt-3">
      <div className="flex items-baseline justify-between gap-4">
        <div className="text-[12px] text-ink-2">
          Next {n} hours <span className="text-ink-3">· the hot afternoons are the thirsty hours</span>
        </div>
        <div className="flex items-center gap-4 text-[11px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <span className="h-[2px] w-3" style={{ background: "var(--color-s2)" }} />
            Air
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-[2px] w-3" style={{ background: "var(--color-s1)" }} />
            Wet-bulb
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 border-t border-dashed border-ink-3" />
            Tower limit {num(design, 0)} °C
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-[8px] w-3 bg-ink/15" />
            Highest demand
          </span>
          {stressed && (
            <span className="flex items-center gap-1.5">
              <span className="h-[3px] w-3" style={{ background: "var(--color-warn)" }} />
              Cooling stress
            </span>
          )}
        </div>
      </div>

      <div
        ref={ref}
        className="relative mt-1 select-none"
        style={{ height: total }}
        role="img"
        aria-label={`Air temperature and water demand for the next ${n} hours. Water demand peaks at ${num(projection.horizon.peak_makeup_m3_h, 1)} cubic metres an hour on ${dayClock(projection.horizon.peak_makeup_time, offset)}.`}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / Math.max(1, r.width)) * (n - 1)))));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {width > 0 && (
          <svg width={width} height={total} className="block overflow-visible">
            {bands.map(({ p, from }) => (
              <rect
                key={p.start}
                x={x(from)}
                y={air.top - 4}
                width={Math.max(2, x(from + p.hours - 1) - x(from))}
                height={wat.top + wat.h - air.top + 4}
                className="fill-ink/[0.07]"
              />
            ))}
            {days.map(({ t, i }) => (
              <g key={t}>
                <line x1={x(i)} x2={x(i)} y1={air.top - 4} y2={stressY + 4} className="stroke-line-2" strokeDasharray="2 3" />
                <text x={x(i) + 4} y={total - 2} className="fill-ink-3 text-[10.5px]">
                  {dayLabel(t, offset)}
                </text>
              </g>
            ))}

            {/* air */}
            <text x={0} y={air.top - 7} className="fill-ink-3 text-[10.5px]">
              Air °C
            </text>
            <line x1={0} x2={width} y1={yAir(design)} y2={yAir(design)} className="stroke-ink-3" strokeDasharray="4 4" strokeWidth={1} />
            <path d={path(projection.t_db_c, yAir)} fill="none" stroke="var(--color-s2)" strokeWidth={1.6} strokeLinejoin="round" />
            <path d={path(projection.t_wb_c, yAir)} fill="none" stroke="var(--color-s1)" strokeWidth={1.6} strokeLinejoin="round" />

            {/* water */}
            <text x={0} y={wat.top - 7} className="fill-ink-3 text-[10.5px]">
              Water m³/h
            </text>
            <path d={waterLine} fill="none" className="stroke-ink" strokeWidth={2} strokeLinejoin="round" />
            {peakAt >= 0 && (
              <g>
                <circle cx={x(peakAt)} cy={yWat(water[peakAt])} r={3} className="fill-ink" />
                <text
                  x={x(peakAt) + (x(peakAt) > width - 60 ? -7 : x(peakAt) < 60 ? 7 : 0)}
                  y={yWat(water[peakAt]) - 7}
                  textAnchor={x(peakAt) > width - 60 ? "end" : x(peakAt) < 60 ? "start" : "middle"}
                  className="fill-ink text-[10.5px] font-medium"
                >
                  peak {num(water[peakAt], 1)} m³/h
                </text>
              </g>
            )}

            {/* cooling stress: quiet unless it rises */}
            {projection.stress_level.map((level, i) => (
              <rect
                key={i}
                x={x(i) - width / n / 2 + 0.5}
                y={stressY}
                width={Math.max(1, width / n - 1)}
                height={3}
                fill={level === "nominal" ? "var(--color-line)" : LEVEL_COLOUR[level]}
              />
            ))}

            {h !== null && <line x1={x(h)} x2={x(h)} y1={air.top - 4} y2={stressY + 3} className="stroke-ink-2" strokeWidth={1} />}
          </svg>
        )}
        {h !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 whitespace-nowrap border border-line-2 bg-panel px-2 py-1 text-[11px] text-ink-2"
            style={x(h) > width * 0.62 ? { right: width - x(h) + 8 } : { left: x(h) + 8 }}
          >
            <span className="text-ink">{dayClock(times[h], offset)}</span>
            {"  "}
            <span className="num">{num(projection.t_db_c[h], 1)} °C</span> air, <span className="num">{num(projection.t_wb_c[h], 1)} °C</span> wet-bulb,{" "}
            <span className="num text-ink">{num(water[h], 1)} m³/h</span>
            {projection.stress_level[h] !== "nominal" ? `, stress ${LEVEL_LABEL[projection.stress_level[h]].toLowerCase()}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

// --- the beige rail: the story in three steps ----------------------------------------

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-5 pb-5 pt-4">
      <div className="mb-3 flex items-baseline gap-2.5">
        <span className="num text-[11px] text-ink-3">{n}</span>
        <h2 className="title">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Reading({
  label,
  value,
  unit,
  digits = 1,
  swatch,
  hint,
}: {
  label: string;
  value: number | null | undefined;
  unit: string;
  digits?: number;
  swatch?: string;
  hint?: string;
}) {
  return (
    <div title={hint}>
      <div className="label mb-1.5 flex items-center gap-1.5">
        {swatch && <span className="h-[2px] w-2.5" style={{ background: swatch }} />}
        {label}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="figure text-[26px] font-medium leading-none">{num(value, digits)}</span>
        <span className="text-[12px] text-ink-3">{unit}</span>
      </div>
    </div>
  );
}

function Attention({ alerts, offset }: { alerts: Alert[]; offset: number }) {
  const setView = useApp((s) => s.setView);
  const list = alerts.filter((a) => a.severity !== "info");
  if (!list.length) return null;
  return (
    <section className="border-b border-line px-5 py-3.5" style={{ background: "color-mix(in srgb, var(--color-warn) 8%, transparent)" }}>
      {list.slice(0, 2).map((a) => (
        <div key={a.id} className="flex gap-2.5 py-1">
          <span
            className="mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full"
            style={{ background: a.severity === "critical" ? "var(--color-crit)" : "var(--color-warn)" }}
          />
          <div className="min-w-0">
            <div className="text-[12.5px] font-medium text-ink">
              {a.title}
              {a.time && <span className="num ml-2 text-[11px] font-normal text-ink-3">{dayClock(a.time, offset)}</span>}
            </div>
            <div className="text-[11.5px] leading-snug text-ink-2">{a.detail}</div>
          </div>
        </div>
      ))}
      {list.length > 2 && (
        <button onClick={() => setView("intelligence")} className="mt-1 text-[11.5px] text-ink-2 underline-offset-2 hover:underline">
          {list.length - 2} more in Intelligence
        </button>
      )}
    </section>
  );
}

function Outside({ overview }: { overview: Overview }) {
  const offset = useOffset();
  const now = overview.now!;
  const horizon = overview.projection!.horizon;
  const design = overview.facility.limits.tower_design_wet_bulb_c;
  const peak = horizon.max_wet_bulb_c;
  const when = dayClock(horizon.max_wet_bulb_time, offset);
  const sentence =
    peak >= design
      ? `Wet-bulb reaches ${num(peak, 1)} °C on ${when}, above the ${num(design, 0)} °C the towers are built for. Condenser water will run warm then.`
      : peak >= design - 2
        ? `Wet-bulb peaks at ${num(peak, 1)} °C on ${when}, close to the ${num(design, 0)} °C the towers are built for.`
        : `Wet-bulb peaks at ${num(peak, 1)} °C on ${when}, well under the ${num(design, 0)} °C the towers are built for, so they have room.`;
  return (
    <Step n="01" title="Outside">
      <div className="flex items-end gap-7">
        <Reading label="Air" value={now.conditions.t_db_c} unit="°C" swatch="var(--color-s2)" />
        <Reading
          label="Wet-bulb"
          value={now.conditions.t_wb_c}
          unit="°C"
          swatch="var(--color-s1)"
          hint="The coldest temperature evaporation can reach. It limits how far the cooling towers can cool their water."
        />
        <Reading label="Humidity" value={now.conditions.rh_pct} unit="%" digits={0} />
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">{sentence}</p>
    </Step>
  );
}

function WaterStep({ overview }: { overview: Overview }) {
  const now = overview.now!;
  const day = overview.projection!.day;
  const share = day.allocation_utilisation ?? 0;
  const over = share > 1;
  const evaporated = now.water.makeup_m3_h > 0 ? now.water.evaporation_m3_h / now.water.makeup_m3_h : 0;
  return (
    <Step n="02" title="Water">
      <div className="flex items-baseline gap-1.5">
        <span className="figure text-[34px] font-medium leading-none">{num(day.makeup_m3, 0)}</span>
        <span className="text-[13px] text-ink-3">m³ needed in the next {day.hours} h</span>
      </div>
      <div className="mt-3.5">
        <div
          className="relative h-[10px] bg-line"
          role="meter"
          aria-label="Share of the daily water allowance"
          aria-valuenow={Math.round(share * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, share * 100)}%`, background: over ? "var(--color-crit)" : "var(--color-s1)" }} />
        </div>
        <div className="mt-1.5 flex justify-between text-[11.5px] text-ink-3">
          <span>
            <span className={`num ${over ? "text-crit" : "text-ink-2"}`}>{num(share * 100, 0)} %</span> of the allowance
          </span>
          <span className="num">{num(day.allocation_m3, 0)} m³ allowed</span>
        </div>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">
        {num(evaporated * 100, 0)} % of it evaporates in the towers. The rest is drained as blowdown so minerals do not build up.
      </p>
    </Step>
  );
}

function energyClause(pct: number | null): React.ReactNode {
  if (pct === null || Math.abs(pct) < 0.05) return "at the same cooling energy";
  return pct > 0 ? (
    <>
      in exchange for <span className="num text-ink">{num(pct, 1)} %</span> more cooling energy
    </>
  ) : (
    <>
      and <span className="num text-ink">{num(-pct, 1)} %</span> less cooling energy
    </>
  );
}

function Decision({ overview, onApprove }: { overview: Overview; onApprove: (r: ApprovalRequest) => void }) {
  const optimisation = useApp((s) => s.optimisation);
  const status = useApp((s) => s.optimisationStatus);
  const error = useApp((s) => s.optimisationError);
  const setView = useApp((s) => s.setView);
  const chosen = optimisation?.scenarios.find((s) => s.key === optimisation.recommended);
  const deltas = chosen?.deltas;
  return (
    <Step n="03" title="What to change">
      {!optimisation && status !== "error" && <Skeleton lines={3} />}
      {status === "error" && <Note tone="warn">{error ?? "No recommendation is available."}</Note>}
      {optimisation && chosen && (
        <div className="rise">
          {chosen.key === "baseline" || !deltas ? (
            <>
              <div className="text-[17px] font-medium text-ink">Keep the current settings.</div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">{optimisation.recommendation_reason}</p>
            </>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className="figure text-[34px] font-medium leading-none" style={{ color: "var(--color-teal)" }}>
                  {signed(deltas.makeup_pct, 0)} %
                </span>
                <span className="text-[13px] text-ink-2">water</span>
              </div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">
                {energyClause(deltas.energy_pct)} over the next {optimisation.window_hours} h, by changing {chosen.changes.length} setting
                {chosen.changes.length === 1 ? "" : "s"} to the {chosen.label.toLowerCase()} set-up.
              </p>
              <div className="mt-4 flex items-center gap-2">
                <Btn
                  kind="primary"
                  onClick={() =>
                    onApprove({
                      title: `Apply the ${chosen.label.toLowerCase()} configuration`,
                      source: `recommendation: ${chosen.label.toLowerCase()}`,
                      config: chosen.config,
                      changes: diffConfig(overview.controls, overview.config, chosen.config),
                      deltas: chosen.deltas,
                      windowHours: optimisation.window_hours,
                      feasible: chosen.feasible,
                    })
                  }
                >
                  <Icon name="lock" size={12} />
                  Review and approve
                </Btn>
                <Btn kind="quiet" onClick={() => setView("simulation")}>
                  Compare options
                </Btn>
              </div>
              <p className="mt-2.5 text-[11px] text-ink-3">Nothing changes until an operator approves.</p>
            </>
          )}
        </div>
      )}
    </Step>
  );
}

function NoWeather({ overview }: { overview: Overview }) {
  const refreshWeather = useApp((s) => s.refreshWeather);
  const setWeatherMode = useApp((s) => s.setWeatherMode);
  const busy = useApp((s) => s.busy);
  return (
    <Step n="01" title="Outside">
      <Note tone="crit">{overview.weather.error?.message ?? "No weather data is available."}</Note>
      <p className="mt-2.5 text-[12px] leading-snug text-ink-3">
        The plant is simulated against the weather, so nothing is shown until data arrives. No substitute data is used.
      </p>
      <div className="mt-3 flex gap-2">
        <Btn onClick={refreshWeather} disabled={busy}>
          <Icon name="refresh" size={12} />
          Retry
        </Btn>
        <Btn onClick={() => setWeatherMode("demo")} disabled={busy}>
          Use demo data
        </Btn>
      </div>
    </Step>
  );
}

export default function Operations() {
  const overview = useApp((s) => s.overview);
  const selected = useApp((s) => s.selected);
  const select = useApp((s) => s.select);
  const setView = useApp((s) => s.setView);
  const offset = useOffset();
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  if (!overview) return null;
  const { projection, now, config_meta: meta } = overview;
  const item = now?.equipment.find((e) => e.id === selected);

  return (
    <div className="flex h-full min-h-0">
      <div className="stage flex min-w-0 flex-1 flex-col bg-bg">
        <Headline overview={overview} />
        <TwinSlot className="relative min-h-0 flex-1">
          {item && (
            <div className="rise absolute right-4 top-3 z-[2] w-[264px] border border-line-2 bg-panel/95 p-3">
              <Inspector item={item} onClose={() => select(null)} />
              <button onClick={() => setView("twin")} className="mt-2 flex items-center gap-1 text-[11px] text-accent hover:underline">
                Open in digital twin <Icon name="chevron" size={10} />
              </button>
            </div>
          )}
        </TwinSlot>
        {projection && (
          <Timeline
            projection={projection}
            offset={offset}
            design={overview.facility.limits.tower_design_wet_bulb_c}
          />
        )}
      </div>

      <aside className="flex w-[372px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel">
        <Attention alerts={overview.alerts} offset={offset} />
        {now && projection ? (
          <>
            <Outside overview={overview} />
            <WaterStep overview={overview} />
            <Decision overview={overview} onApprove={setApproval} />
          </>
        ) : (
          <NoWeather overview={overview} />
        )}
        <footer className="mt-auto px-5 py-3 text-[11px] leading-snug text-ink-3">
          Running the {meta.source}
          {meta.approved_by ? `, approved by ${meta.approved_by}` : ""}. Every plant value is simulated, not measured.
        </footer>
      </aside>
      {approval && <ApprovalDialog request={approval} onClose={() => setApproval(null)} />}
    </div>
  );
}
