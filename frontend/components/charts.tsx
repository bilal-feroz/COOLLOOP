"use client";

// A small chart kit drawn in SVG. Every chart shares the same anatomy:
// hairline grid, one y-axis, 2 px lines, a legend when there are two or more
// series, a crosshair with tooltip (mouse and keyboard), and a table view of
// the same data.

import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clock, compact, dayClock, dayLabel, localHour, num } from "@/lib/format";
import type { StressLevel } from "@/lib/types";
import { Icon, LEVEL_COLOUR, LEVEL_LABEL } from "./ui";

export interface Series {
  key: string;
  label: string;
  colour: string;
  values: (number | null)[];
  dashed?: boolean;
  kind?: "line" | "bar";
  area?: boolean;
}

export interface RefLine {
  value: number;
  label: string;
  colour?: string;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Round axis limits and ticks: 0 / 5 / 10, 20 / 25 / 30 ... */
function niceScale(min: number, max: number, target = 4): { lo: number; hi: number; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };
  if (max - min < 1e-9) {
    const pad = Math.abs(max) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step * 0.001; v += step) ticks.push(Number(v.toFixed(10)));
  return { lo, hi, ticks };
}

function Legend({ series }: { series: Series[] }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-0.5">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-ink-2">
          <svg width="14" height="6" aria-hidden>
            <line x1="0" y1="3" x2="14" y2="3" stroke={s.colour} strokeWidth="2" strokeDasharray={s.dashed ? "4 3" : undefined} />
          </svg>
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function Frame({
  title,
  unit,
  legend,
  children,
  table,
  right,
}: {
  title: string;
  unit?: string;
  legend?: ReactNode;
  children: ReactNode;
  table?: ReactNode;
  right?: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1.5 flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex shrink-0 items-baseline gap-1.5">
          <span className="whitespace-nowrap text-[12px] text-ink">{title}</span>
          {unit && <span className="shrink-0 text-[11px] text-ink-3">{unit}</span>}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {legend}
          {right}
          {table && (
            <button
              onClick={() => setShowTable((v) => !v)}
              title={showTable ? "Show chart" : "Show data table"}
              aria-pressed={showTable}
              className={`flex h-5 w-5 items-center justify-center ${showTable ? "text-accent" : "text-ink-3 hover:text-ink"}`}
            >
              <Icon name={showTable ? "chart" : "table"} size={13} />
            </button>
          )}
        </div>
      </figcaption>
      {showTable && table ? table : children}
    </figure>
  );
}

function DataTable({
  times,
  offset,
  series,
  unit,
  digits,
  height,
}: {
  times: string[];
  offset: number;
  series: Series[];
  unit?: string;
  digits: number;
  height: number;
}) {
  return (
    <div className="overflow-auto border border-line" style={{ maxHeight: height }}>
      <table className="w-full border-collapse text-[11px]">
        <thead className="sticky top-0 bg-panel">
          <tr className="text-left text-ink-3">
            <th className="px-2 py-1 font-normal">Time</th>
            {series.map((s) => (
              <th key={s.key} className="px-2 py-1 text-right font-normal">
                {s.label}
                {unit ? ` (${unit})` : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {times.map((t, i) => (
            <tr key={t} className="border-t border-line">
              <td className="num px-2 py-[3px] text-ink-2">{dayClock(t, offset)}</td>
              {series.map((s) => (
                <td key={s.key} className="num px-2 py-[3px] text-right">
                  {num(s.values[i], digits)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const M = { left: 38, right: 8, top: 8, bottom: 20 };

export function TimeChart({
  title,
  unit,
  times,
  offset,
  series,
  refs = [],
  height = 132,
  digits = 1,
  zero = false,
  right,
  bands = [],
  marker,
}: {
  title: string;
  unit?: string;
  times: string[];
  offset: number;
  series: Series[];
  refs?: RefLine[];
  height?: number;
  digits?: number;
  /** Start the y-axis at zero (always on for bars). */
  zero?: boolean;
  right?: ReactNode;
  /** Index ranges to shade, for example high-demand periods. */
  bands?: { from: number; to: number }[];
  /** A point in time to mark, for example where history ends and the forecast begins. */
  marker?: { index: number; label: string };
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const clip = useId();
  const n = times.length;
  const hasBars = series.some((s) => s.kind === "bar");

  const scale = useMemo(() => {
    const values = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
    refs.forEach((r) => values.push(r.value));
    if (!values.length) return niceScale(0, 1);
    const lo = zero || hasBars ? Math.min(0, ...values) : Math.min(...values);
    return niceScale(lo, Math.max(...values, hasBars ? 0.5 : -Infinity));
  }, [series, refs, zero, hasBars]);

  const plotW = Math.max(10, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;
  const band = n > 0 ? plotW / (hasBars ? n : Math.max(1, n - 1)) : plotW;
  const x = (i: number) => M.left + (hasBars ? (i + 0.5) * band : i * band);
  const y = (v: number) => M.top + plotH - ((v - scale.lo) / (scale.hi - scale.lo)) * plotH;

  const xTicks = useMemo(() => {
    const step = n <= 26 ? 6 : n <= 50 ? 12 : 24;
    const out: { i: number; label: string; day: boolean }[] = [];
    times.forEach((t, i) => {
      const h = localHour(t, offset);
      if (h % step !== 0) return;
      out.push({ i, label: h === 0 ? dayLabel(t, offset) : `${String(h).padStart(2, "0")}:00`, day: h === 0 });
    });
    return out;
  }, [times, offset, n]);
  const minGap = 46;
  let lastLabel = -Infinity;

  const pick = (clientX: number) => {
    const el = ref.current;
    if (!el || n === 0) return;
    const px = clientX - el.getBoundingClientRect().left - M.left;
    const i = hasBars ? Math.floor(px / band) : Math.round(px / band);
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const tooltipLeft = hover !== null ? x(hover) : 0;
  const flip = tooltipLeft > width * 0.6;

  return (
    <Frame
      title={title}
      unit={unit}
      right={right}
      legend={series.length > 1 ? <Legend series={series} /> : undefined}
      table={<DataTable times={times} offset={offset} series={series} unit={unit} digits={digits} height={height} />}
    >
      <div
        ref={ref}
        className="relative select-none outline-none focus-visible:ring-1 focus-visible:ring-accent"
        style={{ height }}
        tabIndex={0}
        role="img"
        aria-label={`${title}${unit ? `, ${unit}` : ""}. Use the left and right arrow keys to read values.`}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
          else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
          else if (e.key === "Escape") setHover(null);
          else return;
          e.preventDefault();
        }}
      >
        {width > 0 && n > 0 && (
          <svg width={width} height={height} className="block overflow-visible">
            <defs>
              <clipPath id={clip}>
                <rect x={M.left} y={M.top - 2} width={plotW} height={plotH + 4} />
              </clipPath>
            </defs>
            {scale.ticks.map((t) => (
              <g key={t}>
                <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth="1" />
                <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="num fill-ink-3 text-[10px]">
                  {compact(t)}
                </text>
              </g>
            ))}
            {xTicks.map((t) => {
              const px = hasBars ? M.left + t.i * band : x(t.i);
              const show = px - lastLabel >= minGap && px < width - 18;
              if (show) lastLabel = px;
              return (
                <g key={t.i}>
                  {t.day && <line x1={px} x2={px} y1={M.top} y2={M.top + plotH} stroke="var(--color-line-2)" strokeWidth="1" />}
                  <line x1={px} x2={px} y1={M.top + plotH} y2={M.top + plotH + 3} stroke="var(--color-line-2)" />
                  {show && (
                    <text x={px} y={height - 5} textAnchor="middle" className={`num text-[10px] ${t.day ? "fill-ink-2" : "fill-ink-3"}`}>
                      {t.label}
                    </text>
                  )}
                </g>
              );
            })}
            <line x1={M.left} x2={width - M.right} y1={M.top + plotH} y2={M.top + plotH} stroke="var(--color-line-2)" />

            {bands.map((b) => (
              <rect
                key={`${b.from}-${b.to}`}
                x={x(b.from) - band / 2}
                y={M.top}
                width={Math.max(2, x(b.to) - x(b.from) + band)}
                height={plotH}
                fill="var(--color-warn)"
                opacity="0.09"
              />
            ))}
            {marker && marker.index > 0 && marker.index < n && (
              <g>
                <rect x={M.left} y={M.top} width={x(marker.index) - M.left} height={plotH} fill="var(--color-bg)" opacity="0.45" />
                <line x1={x(marker.index)} x2={x(marker.index)} y1={M.top - 2} y2={M.top + plotH} stroke="var(--color-ink-2)" strokeWidth="1" />
                <text x={x(marker.index) + 4} y={M.top + 8} className="fill-ink-2 text-[10px]">
                  {marker.label}
                </text>
              </g>
            )}

            {refs.map((r) => (
              <g key={r.label}>
                <line x1={M.left} x2={width - M.right} y1={y(r.value)} y2={y(r.value)} stroke={r.colour ?? "var(--color-ink-3)"} strokeWidth="1" />
                <text x={width - M.right - 3} y={y(r.value) - 4} textAnchor="end" className="fill-ink-3 text-[10px]">
                  {r.label}
                </text>
              </g>
            ))}

            <g clipPath={`url(#${clip})`}>
              {series.map((s) => {
                if (s.kind === "bar") {
                  const w = Math.max(1, Math.min(24, band - 2));
                  return s.values.map((v, i) => {
                    if (v === null || v <= 0) return null;
                    const top = y(v);
                    const h = y(0) - top;
                    const r = Math.min(4, w / 2, h);
                    return (
                      <path
                        key={`${s.key}-${i}`}
                        d={`M${x(i) - w / 2},${y(0)}V${top + r}q0,${-r} ${r},${-r}h${w - 2 * r}q${r},0 ${r},${r}V${y(0)}z`}
                        fill={s.colour}
                      />
                    );
                  });
                }
                const segments: string[] = [];
                let open = false;
                s.values.forEach((v, i) => {
                  if (v === null || !Number.isFinite(v)) {
                    open = false;
                    return;
                  }
                  segments.push(`${open ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
                  open = true;
                });
                const d = segments.join("");
                const first = s.values.findIndex((v) => v !== null);
                const last = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
                return (
                  <g key={s.key}>
                    {s.area && first >= 0 && (
                      <path d={`${d}L${x(last)},${y(scale.lo)}L${x(first)},${y(scale.lo)}z`} fill={s.colour} opacity="0.1" />
                    )}
                    <path d={d} fill="none" stroke={s.colour} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? "5 4" : undefined} />
                  </g>
                );
              })}
            </g>

            {hover !== null && (
              <g pointerEvents="none">
                <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + plotH} stroke="var(--color-ink-3)" strokeWidth="1" />
                {series.map((s) => {
                  const v = s.values[hover];
                  if (v === null || v === undefined || s.kind === "bar") return null;
                  return <circle key={s.key} cx={x(hover)} cy={y(v)} r="4" fill={s.colour} stroke="var(--color-panel)" strokeWidth="2" />;
                })}
              </g>
            )}
          </svg>
        )}
        {hover !== null && (
          <div
            className="pointer-events-none absolute top-1 z-20 min-w-[120px] border border-line-2 bg-raised px-2 py-1.5 shadow-[0_8px_22px_rgba(28,20,10,0.22)]"
            style={flip ? { right: width - tooltipLeft + 10 } : { left: tooltipLeft + 10 }}
          >
            <div className="num mb-1 text-[10.5px] text-ink-3">{dayClock(times[hover], offset)}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center justify-between gap-3 text-[11.5px]">
                <span className="flex items-center gap-1.5 text-ink-2">
                  <span className="h-[7px] w-[7px]" style={{ background: s.colour }} />
                  {s.label}
                </span>
                <span className="num text-ink">
                  {num(s.values[hover], digits)}
                  {unit ? <span className="text-ink-3"> {unit}</span> : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Frame>
  );
}

// --- cooling stress timeline ------------------------------------------------------------
// Nominal hours stay quiet, a step darker than the panel, so only stressed hours stand out.
const STRESS_FILL: Record<StressLevel, string> = { ...LEVEL_COLOUR, nominal: "var(--color-line-2)" };

export function StressStrip({
  times,
  offset,
  values,
  levels,
  drivers,
  height = 16,
}: {
  times: string[];
  offset: number;
  values: number[];
  levels: StressLevel[];
  drivers: string[];
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = times.length;
  const cell = n ? width / n : 0;
  let lastLabel = -Infinity;
  return (
    <div>
      <div
        ref={ref}
        className="relative outline-none focus-visible:ring-1 focus-visible:ring-accent"
        tabIndex={0}
        role="img"
        aria-label="Cooling stress by hour. Use the left and right arrow keys to read values."
        onPointerMove={(e) => {
          const el = ref.current;
          if (!el || !n) return;
          setHover(Math.max(0, Math.min(n - 1, Math.floor((e.clientX - el.getBoundingClientRect().left) / cell))));
        }}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
          else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
          else return;
          e.preventDefault();
        }}
      >
        <svg width={width} height={height + 16} className="block">
          {levels.map((level, i) => (
            <rect key={i} x={i * cell + 1} y={0} width={Math.max(1, cell - 2)} height={height} fill={STRESS_FILL[level]} opacity={hover === null || hover === i ? 1 : 0.55} />
          ))}
          {times.map((t, i) => {
            const h = localHour(t, offset);
            if (h % 12 !== 0) return null;
            const px = i * cell;
            const show = px - lastLabel > 52 && px < width - 30;
            if (show) lastLabel = px;
            return (
              <g key={t}>
                <line x1={px} x2={px} y1={height} y2={height + 4} stroke="var(--color-line-2)" />
                {show && (
                  <text x={px + 3} y={height + 13} className={`num text-[10px] ${h === 0 ? "fill-ink-2" : "fill-ink-3"}`}>
                    {h === 0 ? dayLabel(t, offset) : "12:00"}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute bottom-full z-20 mb-1.5 whitespace-nowrap border border-line-2 bg-raised px-2 py-1.5 shadow-[0_8px_22px_rgba(28,20,10,0.22)]"
            style={hover * cell > width * 0.6 ? { right: width - hover * cell - cell } : { left: hover * cell }}
          >
            <div className="num text-[10.5px] text-ink-3">{dayClock(times[hover], offset)}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px]">
              <span className="h-[7px] w-[7px]" style={{ background: STRESS_FILL[levels[hover]] }} />
              <span className="text-ink">{LEVEL_LABEL[levels[hover]]}</span>
              <span className="num text-ink-2">{num(values[hover], 2)}</span>
            </div>
            <div className="text-[11px] text-ink-3">{drivers[hover]}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function StressLegend() {
  return (
    <div className="flex items-center gap-3">
      {(Object.keys(LEVEL_LABEL) as StressLevel[]).map((level) => (
        <span key={level} className="flex items-center gap-1.5 text-[10.5px] text-ink-2">
          <span className="h-[7px] w-[7px]" style={{ background: STRESS_FILL[level] }} />
          {LEVEL_LABEL[level]}
        </span>
      ))}
    </div>
  );
}

// --- water against energy -------------------------------------------------------------------
export interface TradePoint {
  key: string;
  label: string;
  colour: string;
  water: number;
  energy: number;
  feasible: boolean;
  hollow?: boolean;
}

export function TradeoffChart({
  curve,
  points,
  height = 210,
}: {
  curve: { water: number; energy: number; feasible: boolean; share: number }[];
  points: TradePoint[];
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const m = { left: 46, right: 14, top: 10, bottom: 30 };
  const xs = niceScale(0, Math.max(...curve.map((c) => c.water), ...points.map((p) => p.water), 1));
  const all = [...curve.map((c) => c.energy), ...points.map((p) => p.energy)];
  const ys = niceScale(Math.min(...all), Math.max(...all));
  const plotW = Math.max(10, width - m.left - m.right);
  const plotH = height - m.top - m.bottom;
  const x = (v: number) => m.left + ((v - xs.lo) / (xs.hi - xs.lo)) * plotW;
  const y = (v: number) => m.top + plotH - ((v - ys.lo) / (ys.hi - ys.lo)) * plotH;
  const path = (items: typeof curve) => items.map((c, i) => `${i ? "L" : "M"}${x(c.water).toFixed(1)},${y(c.energy).toFixed(1)}`).join("");
  const feasible = curve.filter((c) => c.feasible);
  const active = points.find((p) => p.key === hover);

  // Keep point labels apart: place each on the side with more room.
  const labelled = [...points].sort((a, b) => a.water - b.water);
  return (
    <Frame
      title="Water against cooling energy"
      unit="window totals"
      table={
        <div className="overflow-auto border border-line" style={{ maxHeight: height }}>
          <table className="w-full border-collapse text-[11px]">
            <thead className="sticky top-0 bg-panel text-left text-ink-3">
              <tr>
                <th className="px-2 py-1 font-normal">Point</th>
                <th className="px-2 py-1 text-right font-normal">Makeup (m³)</th>
                <th className="px-2 py-1 text-right font-normal">Energy (kWh)</th>
                <th className="px-2 py-1 text-right font-normal">Feasible</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.key} className="border-t border-line">
                  <td className="px-2 py-[3px] text-ink">{p.label}</td>
                  <td className="num px-2 py-[3px] text-right">{num(p.water, 0)}</td>
                  <td className="num px-2 py-[3px] text-right">{num(p.energy, 0)}</td>
                  <td className="px-2 py-[3px] text-right text-ink-2">{p.feasible ? "yes" : "no"}</td>
                </tr>
              ))}
              {curve.map((c) => (
                <tr key={c.share} className="border-t border-line text-ink-2">
                  <td className="px-2 py-[3px]">Evaporative share {num(c.share * 100, 0)} %</td>
                  <td className="num px-2 py-[3px] text-right">{num(c.water, 0)}</td>
                  <td className="num px-2 py-[3px] text-right">{num(c.energy, 0)}</td>
                  <td className="px-2 py-[3px] text-right">{c.feasible ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      }
    >
      <div ref={ref} className="relative" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} className="block overflow-visible">
            {ys.ticks.map((t) => (
              <g key={t}>
                <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" />
                <text x={m.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="num fill-ink-3 text-[10px]">
                  {compact(t)}
                </text>
              </g>
            ))}
            {xs.ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={m.top + plotH} y2={m.top + plotH + 3} stroke="var(--color-line-2)" />
                <text x={x(t)} y={m.top + plotH + 14} textAnchor="middle" className="num fill-ink-3 text-[10px]">
                  {compact(t)}
                </text>
              </g>
            ))}
            <line x1={m.left} x2={width - m.right} y1={m.top + plotH} y2={m.top + plotH} stroke="var(--color-line-2)" />
            <text x={m.left + plotW / 2} y={height - 3} textAnchor="middle" className="fill-ink-3 text-[10px]">
              Makeup water, m³
            </text>
            <text transform={`translate(10 ${m.top + plotH / 2}) rotate(-90)`} textAnchor="middle" className="fill-ink-3 text-[10px]">
              Cooling energy, kWh
            </text>

            <path d={path(curve)} fill="none" stroke="var(--color-line-2)" strokeWidth="2" strokeDasharray="3 4" />
            {feasible.length > 1 && <path d={path(feasible)} fill="none" stroke="var(--color-neutral)" strokeWidth="2" strokeLinecap="round" />}

            {labelled.map((p, i) => {
              const px = x(p.water);
              const py = y(p.energy);
              const left = px > m.left + plotW * 0.7;
              const up = i % 2 === 0;
              return (
                <g
                  key={p.key}
                  onPointerEnter={() => setHover(p.key)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(p.key)}
                  onBlur={() => setHover(null)}
                  tabIndex={0}
                  role="img"
                  aria-label={`${p.label}: ${num(p.water, 0)} cubic metres, ${num(p.energy, 0)} kilowatt hours${p.feasible ? "" : ", not feasible"}`}
                  className="outline-none"
                >
                  <circle cx={px} cy={py} r="13" fill="transparent" />
                  <circle cx={px} cy={py} r="5.5" fill={p.hollow ? "var(--color-panel)" : p.colour} stroke={p.hollow ? p.colour : "var(--color-panel)"} strokeWidth="2" />
                  {!p.feasible && <path d={`M${px - 3},${py - 3}l6,6M${px + 3},${py - 3}l-6,6`} stroke="var(--color-crit)" strokeWidth="1.5" />}
                  <text x={px + (left ? -10 : 10)} y={py + (up ? -9 : 15)} textAnchor={left ? "end" : "start"} className="fill-ink-2 text-[10.5px]">
                    {p.label}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
        {active && (
          <div className="pointer-events-none absolute right-2 top-1 z-20 border border-line-2 bg-raised px-2 py-1.5 text-[11.5px] shadow-[0_8px_22px_rgba(28,20,10,0.22)]">
            <div className="mb-0.5 flex items-center gap-1.5 text-ink">
              <span className="h-[7px] w-[7px]" style={{ background: active.colour }} />
              {active.label}
            </div>
            <div className="num text-ink-2">{num(active.water, 0)} m³ makeup</div>
            <div className="num text-ink-2">{num(active.energy, 0)} kWh cooling</div>
            {!active.feasible && <div className="text-crit">Breaks a limit</div>}
          </div>
        )}
      </div>
    </Frame>
  );
}

/** Small inline trend for a stat. */
export function Spark({ values, colour = "var(--color-neutral)", width = 72, height = 18 }: { values: number[]; colour?: string; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - lo) / span) * (height - 4)).toFixed(1)}`).join("");
  return (
    <svg width={width} height={height} aria-hidden>
      <path d={d} fill="none" stroke={colour} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export { clock };
