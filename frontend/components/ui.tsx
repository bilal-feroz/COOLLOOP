"use client";

// Interface primitives. Deliberately few: hairline-separated panels, mono
// numerals for telemetry, square corners, status colour only for state.

import type { ReactNode } from "react";
import { num } from "@/lib/format";
import type { EquipmentStatus, Status, StressLevel } from "@/lib/types";

// --- icons (1.5 px stroke, 16 px grid) -------------------------------------------
const ICONS = {
  operations: "M2.5 13.5h11M4 11V7.5M8 11V3.5M12 11V6",
  twin: "M8 1.8l5.5 3.1v6.2L8 14.2l-5.5-3.1V4.9L8 1.8zM2.5 4.9L8 8l5.5-3.1M8 8v6.2",
  simulation: "M2.5 4.5h4M9.5 4.5h4M2.5 11.5h7M12.5 11.5h1M8 3v3M11 10v3",
  intelligence: "M8 2.2v2M8 11.8v2M2.2 8h2M11.8 8h2M8 5.4a2.6 2.6 0 100 5.2 2.6 2.6 0 000-5.2zM4 4l1.3 1.3M10.7 10.7L12 12M12 4l-1.3 1.3M5.3 10.7L4 12",
  refresh: "M13 8a5 5 0 11-1.5-3.6M13 2.5v2.4h-2.4",
  replay: "M3 8a5 5 0 101.5-3.6M3 2.5v2.4h2.4M8 5.4V8l1.9 1.2",
  alert: "M8 2.5l6 10.5H2L8 2.5zM8 6.8v3M8 11.6v.2",
  check: "M3.2 8.4l3 3 6.6-7",
  close: "M3.5 3.5l9 9M12.5 3.5l-9 9",
  info: "M8 14A6 6 0 108 2a6 6 0 000 12zM8 7.2v3.6M8 5.2v.2",
  chevron: "M5.5 3.5L10 8l-4.5 4.5",
  table: "M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.5 3.5v9",
  chart: "M2.5 12.5l3.5-4 2.6 2.2 4.9-6.2",
  lock: "M4.5 7.5h7v5.5h-7zM6 7.5V5.6a2 2 0 014 0v1.9",
  target: "M8 13.5a5.5 5.5 0 100-11 5.5 5.5 0 000 11zM8 10a2 2 0 100-4 2 2 0 000 4z",
  send: "M2.5 8l11-5-4.2 11-2-4.6L2.5 8z",
  site: "M8 14s4.5-4 4.5-7.5a4.5 4.5 0 00-9 0C3.5 10 8 14 8 14zM8 8a1.6 1.6 0 100-3.2A1.6 1.6 0 008 8z",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 14, className = "" }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

// --- status vocabulary ----------------------------------------------------------------
export const LEVEL_COLOUR: Record<StressLevel, string> = {
  nominal: "var(--color-teal)",
  elevated: "var(--color-warn)",
  high: "var(--color-serious)",
  critical: "var(--color-crit)",
};
export const LEVEL_LABEL: Record<StressLevel, string> = {
  nominal: "Nominal",
  elevated: "Elevated",
  high: "High",
  critical: "Critical",
};
export const STATE_COLOUR: Record<EquipmentStatus, string> = {
  running: "var(--color-accent)",
  standby: "var(--color-ink-3)",
  off: "var(--color-line-2)",
  warning: "var(--color-warn)",
  fault: "var(--color-crit)",
};
export const STATE_LABEL: Record<EquipmentStatus, string> = {
  running: "Running",
  standby: "Standby",
  off: "Off",
  warning: "Warning",
  fault: "Fault",
};
export const CHECK_COLOUR: Record<Status, string> = {
  ok: "var(--color-teal)",
  warning: "var(--color-warn)",
  violated: "var(--color-crit)",
  "n/a": "var(--color-ink-3)",
};
export const CHECK_LABEL: Record<Status, string> = { ok: "OK", warning: "Close", violated: "Violated", "n/a": "N/A" };

export function Dot({ colour, pulse = false, size = 7 }: { colour: string; pulse?: boolean; size?: number }) {
  return <span className={`inline-block shrink-0 rounded-full ${pulse ? "pulse" : ""}`} style={{ width: size, height: size, background: colour }} />;
}

export function Tag({ children, colour = "var(--color-ink-3)", solid = false }: { children: ReactNode; colour?: string; solid?: boolean }) {
  return (
    <span
      className="num inline-flex h-[18px] items-center gap-1 whitespace-nowrap border px-1.5 text-[10px] font-medium uppercase leading-none tracking-[0.04em]"
      style={{
        borderColor: `color-mix(in srgb, ${colour} 55%, transparent)`,
        color: solid ? "var(--color-bg)" : colour,
        background: solid ? colour : `color-mix(in srgb, ${colour} 10%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

// --- layout -------------------------------------------------------------------------------
export function Section({
  title,
  right,
  children,
  className = "",
  pad = true,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section className={`border-b border-line ${className}`}>
      <header className="flex h-9 items-center justify-between gap-2 px-3">
        <h2 className="title">{title}</h2>
        {right}
      </header>
      <div className={pad ? "px-3 pb-3" : ""}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  unit,
  digits = 1,
  sub,
  size = "md",
  tone,
}: {
  label: string;
  value: number | null | undefined;
  unit?: string;
  digits?: number;
  sub?: ReactNode;
  size?: "sm" | "md" | "lg";
  tone?: string;
}) {
  const scale = size === "lg" ? "text-[28px]" : size === "md" ? "text-[19px]" : "text-[13.5px]";
  return (
    <div className="min-w-0">
      <div className="label mb-1.5 truncate">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className={`figure font-medium leading-none ${scale}`} style={tone ? { color: tone } : undefined}>
          {num(value, digits)}
        </span>
        {unit && <span className="text-[11px] leading-none text-ink-3">{unit}</span>}
      </div>
      {sub && <div className="mt-1.5 text-[11px] leading-tight text-ink-3">{sub}</div>}
    </div>
  );
}

/** Utilisation against a limit. The fill carries severity. */
export function Meter({ value, warnAt = 0.9, max = 1, label }: { value: number | null; warnAt?: number; max?: number; label: string }) {
  const v = value ?? 0;
  const colour = v >= max ? "var(--color-crit)" : v >= warnAt ? "var(--color-warn)" : "var(--color-accent)";
  const scale = Math.max(max * 1.15, v);
  return (
    <div role="meter" aria-label={label} aria-valuenow={Math.round(v * 100)} aria-valuemin={0} aria-valuemax={Math.round(max * 100)}>
      <div className="relative h-[5px] bg-line">
        <div className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, (v / scale) * 100)}%`, background: colour }} />
        <div className="absolute -inset-y-[2px] w-px bg-ink-2" style={{ left: `${(max / scale) * 100}%` }} title="Limit" />
      </div>
    </div>
  );
}

// --- controls ---------------------------------------------------------------------------------
export function Btn({
  children,
  onClick,
  kind = "ghost",
  disabled,
  title,
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "ghost" | "danger" | "quiet";
  disabled?: boolean;
  title?: string;
  className?: string;
  type?: "button" | "submit";
}) {
  const styles = {
    primary: "bg-accent text-bg border-accent hover:brightness-110 font-medium",
    ghost: "border-line-2 text-ink hover:border-ink-3 hover:bg-raised",
    danger: "border-crit/60 text-crit hover:bg-crit/10",
    quiet: "border-transparent text-ink-2 hover:text-ink hover:bg-raised",
  }[kind];
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap border px-2.5 text-[12px] leading-none transition-colors disabled:opacity-40 disabled:hover:bg-transparent ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

/** A set of mutually exclusive choices. */
export function Choice<T extends string | number>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className="inline-flex border border-line-2" role="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`${size === "sm" ? "h-[22px] px-2 text-[11px]" : "h-7 px-2.5 text-[12px]"} border-r border-line-2 leading-none transition-colors last:border-r-0 ${
              on ? "bg-ink text-bg" : "text-ink-2 hover:bg-raised hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Check({ on, onChange, label, swatch }: { on: boolean; onChange: () => void; label: string; swatch?: string }) {
  return (
    <button role="switch" aria-checked={on} onClick={onChange} className="flex h-6 items-center gap-2 text-[11.5px] text-ink-2 hover:text-ink">
      <span className={`flex h-[13px] w-[13px] items-center justify-center border ${on ? "border-accent bg-accent text-bg" : "border-line-2"}`}>
        {on && <Icon name="check" size={10} />}
      </span>
      {swatch && <span className="h-[3px] w-3" style={{ background: swatch }} />}
      {label}
    </button>
  );
}

export function Note({ tone = "info", children }: { tone?: "info" | "warn" | "crit"; children: ReactNode }) {
  const colour = tone === "crit" ? "var(--color-crit)" : tone === "warn" ? "var(--color-warn)" : "var(--color-ink-3)";
  return (
    <div className="flex gap-2 border-l-2 bg-inset px-2.5 py-2 text-[11.5px] leading-snug text-ink-2" style={{ borderColor: colour }}>
      <Icon name={tone === "info" ? "info" : "alert"} className="mt-[1px] shrink-0" size={13} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2 py-1" aria-busy>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="pulse h-3 bg-line" style={{ width: `${88 - i * 14}%` }} />
      ))}
    </div>
  );
}

export function Delta({ value, digits = 1, unit = "%", goodWhenDown = true }: { value: number | null | undefined; digits?: number; unit?: string; goodWhenDown?: boolean }) {
  if (value === null || value === undefined) return <span className="num text-ink-3">–</span>;
  const zero = Math.abs(value) < 0.05;
  const good = goodWhenDown ? value < 0 : value > 0;
  const colour = zero ? "var(--color-ink-3)" : good ? "var(--color-teal)" : "var(--color-serious)";
  const arrow = zero ? "" : value < 0 ? "▼" : "▲";
  return (
    <span className="num inline-flex items-baseline gap-[3px] whitespace-nowrap" style={{ color: colour }}>
      <span className="text-[8px]">{arrow}</span>
      {num(Math.abs(value), digits)}
      {unit}
    </span>
  );
}
