"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ago, dateClock, dateOnly, fromLocalInput, fullClock, num, toLocalInput, utcOffsetLabel } from "@/lib/format";
import { useApp, type View } from "@/lib/store";
import type { WeatherBundle } from "@/lib/types";
import { useNow } from "./charts";
import { Btn, Choice, Dot, Icon, type IconName, Meter, Note, Skeleton, Tag } from "./ui";

const TABS: { view: View; label: string; icon: IconName }[] = [
  { view: "operations", label: "Operations", icon: "operations" },
  { view: "twin", label: "Digital twin", icon: "twin" },
  { view: "simulation", label: "Simulation", icon: "simulation" },
  { view: "intelligence", label: "Intelligence", icon: "intelligence" },
];

export function sourceStatus(weather: WeatherBundle | undefined): { label: string; colour: string; pulse: boolean } {
  switch (weather?.status) {
    case "live":
      return { label: "Live", colour: "var(--color-teal)", pulse: false };
    case "cached":
      return { label: "Cached", colour: "var(--color-warn)", pulse: true };
    case "replay":
      return { label: "Replay", colour: "var(--color-warn)", pulse: false };
    case "demo":
      return { label: "Demo data", colour: "var(--color-warn)", pulse: false };
    case "not_configured":
      return { label: "Not configured", colour: "var(--color-crit)", pulse: true };
    case "unavailable":
      return { label: "No weather", colour: "var(--color-crit)", pulse: true };
    default:
      return { label: "Connecting", colour: "var(--color-ink-3)", pulse: true };
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-[11.5px]">
      <span className="text-ink-3">{label}</span>
      <span className="num text-right text-ink">{children}</span>
    </div>
  );
}

const HOUR = 3_600_000;
const subscribeNothing = () => () => {};

/** Pick a past moment to replay: one of the year's hardest hours, or any date. */
function ReplayChooser({ weather }: { weather: WeatherBundle }) {
  const found = useApp((s) => s.extremes);
  const status = useApp((s) => s.extremesStatus);
  const error = useApp((s) => s.extremesError);
  const load = useApp((s) => s.loadExtremes);
  const replay = useApp((s) => s.replay);
  const busy = useApp((s) => s.busy);
  const now = useNow(60_000);
  const offset = weather.location.utc_offset_hours;
  const active = weather.mode === "replay" && weather.replay_at ? Date.parse(weather.replay_at) : null;
  const [custom, setCustom] = useState(() => `${toLocalInput(weather.replay_at ?? new Date(Date.now() - 7 * 24 * HOUR), offset).slice(0, 13)}:00`);
  const customAt = fromLocalInput(custom, offset);
  const customValid = customAt !== null && Date.parse(customAt) <= now;

  useEffect(() => {
    if (status === "idle") load();
  }, [status, load]);

  const lead = found?.extremes.length ? Math.round((Date.parse(found.extremes[0].time) - Date.parse(found.extremes[0].replay_from)) / HOUR) : 0;

  return (
    <div className="border border-line bg-inset">
      <div className="px-2.5 py-2 text-[11.5px] leading-snug text-ink-2">
        {found
          ? `The hardest hours at this site from ${dateOnly(found.scanned_from, offset)} to ${dateOnly(found.scanned_to, offset)}, found in ${num(found.hours, 0)} hourly values of Meteomatics history.`
          : "The hardest hours of the past year at this site, from Meteomatics history."}
      </div>
      {found ? (
        <ul>
          {found.extremes.map((e) => {
            const on = active !== null && active >= Date.parse(e.replay_from) && active <= Date.parse(e.time) + lead * HOUR;
            // The value that makes the hour extreme comes first.
            const wet = `${num(e.wet_bulb_c)} °C wet-bulb`;
            const dry = `${num(e.t_2m_c)} °C dry-bulb`;
            const rh = e.rh_pct !== null ? `${num(e.rh_pct, 0)} % humidity` : null;
            const values = e.kind === "wet_bulb" ? [wet, dry, rh] : e.kind === "dry_bulb" ? [dry, wet, rh] : [rh, dry, wet];
            return (
              <li key={e.kind} className="border-t border-line">
                <button
                  onClick={() => replay(e.replay_from)}
                  disabled={busy}
                  aria-pressed={on}
                  title={e.detail}
                  className={`block w-full border-l-2 px-2.5 py-[7px] text-left transition-colors hover:bg-raised disabled:opacity-50 ${
                    on ? "border-l-warn bg-raised" : "border-l-transparent"
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="text-[12px] text-ink">{e.label}</span>
                    <span className="num shrink-0 text-[11.5px] text-ink-2">{fullClock(e.time, offset)}</span>
                  </span>
                  <span className="num mt-0.5 block text-[11px] text-ink-3">{values.filter(Boolean).join(", ")}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : status === "error" ? (
        <div className="space-y-2 border-t border-line p-2.5">
          <Note tone="crit">{error ?? "The history scan failed."}</Note>
          <Btn onClick={load}>
            <Icon name="refresh" size={12} />
            Scan again
          </Btn>
        </div>
      ) : (
        <div className="border-t border-line px-2.5 py-2">
          <div className="mb-1.5 text-[11px] text-ink-3">Scanning a year of hourly history.</div>
          <Skeleton lines={3} />
        </div>
      )}
      <form
        className="flex items-end gap-2 border-t border-line px-2.5 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (customValid && customAt) replay(customAt);
        }}
      >
        <label className="block grow">
          <span className="mb-1 block text-[10.5px] text-ink-3">Any other moment, site time</span>
          <input
            type="datetime-local"
            step={3600}
            value={custom}
            max={toLocalInput(new Date(now), offset)}
            onChange={(e) => setCustom(e.target.value)}
            className="num h-7 w-full border border-line-2 bg-panel px-2 text-[12px] text-ink outline-none [color-scheme:dark] focus:border-accent"
          />
        </label>
        <Btn type="submit" disabled={!customValid || busy}>
          Replay
        </Btn>
      </form>
      {lead > 0 && (
        <div className="border-t border-line px-2.5 py-1.5 text-[11px] leading-snug text-ink-3">
          A listed hour is replayed from {lead} h before it, so the event is still ahead.
        </div>
      )}
    </div>
  );
}

function SourcePanel({ onClose }: { onClose: () => void }) {
  const weather = useApp((s) => s.overview?.weather);
  const busy = useApp((s) => s.busy);
  const refreshWeather = useApp((s) => s.refreshWeather);
  const setWeatherMode = useApp((s) => s.setWeatherMode);
  const setLocation = useApp((s) => s.setLocation);
  const now = useNow(60_000);
  const [picking, setPicking] = useState(weather?.mode === "replay");
  const [form, setForm] = useState(() => ({
    name: weather?.location.name ?? "",
    lat: String(weather?.location.lat ?? ""),
    lon: String(weather?.location.lon ?? ""),
    offset: String(weather?.location.utc_offset_hours ?? 4),
  }));
  if (!weather) return null;
  const offset = weather.location.utc_offset_hours;
  const status = sourceStatus(weather);
  const replaying = weather.mode === "replay";
  const lat = Number(form.lat);
  const lon = Number(form.lon);
  const utc = Number(form.offset);
  const valid = form.name.trim().length > 1 && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && utc >= -12 && utc <= 14 && form.lat !== "" && form.lon !== "";
  const changed = form.name !== weather.location.name || lat !== weather.location.lat || lon !== weather.location.lon || utc !== offset;
  const quota = weather.quota;
  const daysLeft = quota?.valid_until ? (Date.parse(quota.valid_until) - now) / (24 * HOUR) : null;

  return (
    <div className="rise absolute right-0 top-[calc(100%+1px)] z-50 max-h-[calc(100dvh-60px)] w-[400px] overflow-y-auto border border-line-2 bg-panel shadow-[0_18px_44px_rgba(28,20,10,0.38)]">
      <div className="flex h-9 items-center justify-between border-b border-line px-3">
        <span className="title">Weather data source</span>
        <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close">
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="space-y-3 border-b border-line p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] text-ink">{weather.provider}</div>
            <div className="text-[11.5px] text-ink-3">{weather.model ? `Source: ${weather.model}` : "No model reported"}</div>
          </div>
          <Tag colour={status.colour}>{status.label}</Tag>
        </div>
        <div className="flex items-center justify-between">
          <Choice
            value={picking ? "replay" : weather.mode}
            onChange={(mode) => {
              setPicking(mode === "replay");
              if (mode !== "replay" && mode !== weather.mode) setWeatherMode(mode);
            }}
            options={[
              { value: "live", label: "Live", title: "Current forecast from the Meteomatics Weather API" },
              { value: "replay", label: "Replay", title: "Past weather from Meteomatics history, replayed as if it were now" },
              { value: "demo", label: "Demo", title: "Deterministic synthetic profile, clearly labelled" },
            ]}
          />
          <Btn onClick={refreshWeather} disabled={busy} title={replaying ? "Load the replay period again" : "Request the forecast again now"}>
            <Icon name="refresh" size={12} />
            Refresh
          </Btn>
        </div>
        {picking && <ReplayChooser key={weather.replay_at ?? "none"} weather={weather} />}
        {weather.error && <Note tone="crit">{weather.error.message}</Note>}
        {weather.notice && <Note tone={weather.synthetic || weather.stale || replaying ? "warn" : "info"}>{weather.notice}</Note>}
      </div>

      <div className="border-b border-line p-3">
        <Row label={replaying ? "Replaying from" : "Forecast valid from"}>{dateClock(weather.current?.time, offset, replaying)}</Row>
        <Row label="Retrieved">{weather.fetched_at ? `${dateClock(weather.fetched_at, offset)} (${ago(weather.fetched_at, now)})` : "–"}</Row>
        <Row label="Generated by the API">{dateClock(weather.api_generated_at, offset)}</Row>
        <Row label="Last successful update">{dateClock(weather.last_success_at, offset)}</Row>
        {!replaying && <Row label="Next refresh">{dateClock(weather.next_refresh_at, offset)}</Row>}
        <Row label={replaying ? "Hours held" : "Forecast hours held"}>{weather.hourly.length}</Row>
        {quota && (
          <div className="mt-2">
            <Row label="API queries today">
              {quota.used_today ?? "–"} / {quota.limit_today ?? "–"}
            </Row>
            {quota.limit_today && quota.used_today !== null && <Meter value={quota.used_today / quota.limit_today} label="API quota used" />}
            {(quota.historic_range || quota.historic_access !== null) && (
              <div className="mt-2">
                <Row label="Historical data">
                  {quota.historic_range ? (/^\d{4}/.test(quota.historic_range) ? `from ${quota.historic_range.slice(0, 4)}` : quota.historic_range) : quota.historic_access ? "included" : "not included"}
                </Row>
              </div>
            )}
            {quota.valid_until && daysLeft !== null && (
              <Row label="Account valid until">
                <span style={{ color: daysLeft < 0 ? "var(--color-crit)" : daysLeft < 3 ? "var(--color-warn)" : undefined }}>
                  {dateOnly(quota.valid_until)}
                  {daysLeft < 0 ? ", expired" : `, ${Math.floor(daysLeft)} d left`}
                </span>
              </Row>
            )}
          </div>
        )}
      </div>

      <div className="border-b border-line p-3">
        <div className="label mb-2">Parameters</div>
        <div className="space-y-1.5">
          {weather.parameters.map((p) => (
            <div key={p.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="num text-[11.5px] text-ink">{p.id}</div>
                <div className="text-[11px] leading-snug text-ink-3">{p.detail || p.role}</div>
              </div>
              <Tag
                colour={
                  p.source === "api" ? "var(--color-accent)" : p.source === "unavailable" ? "var(--color-crit)" : "var(--color-warn)"
                }
              >
                {p.source === "api" ? "API" : p.source}
              </Tag>
            </div>
          ))}
          {!weather.parameters.length && <div className="text-[11.5px] text-ink-3">No parameters received.</div>}
        </div>
      </div>

      <form
        className="p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && changed) setLocation({ name: form.name.trim(), lat, lon, utc_offset_hours: utc, elevation_m: weather.location.elevation_m });
        }}
      >
        <div className="label mb-2">Site coordinates</div>
        <div className="grid grid-cols-[1fr_84px_84px_64px] gap-2">
          {(
            [
              ["name", "Name", "text"],
              ["lat", "Latitude", "number"],
              ["lon", "Longitude", "number"],
              ["offset", "UTC offset", "number"],
            ] as const
          ).map(([key, label, type]) => (
            <label key={key} className="block">
              <span className="mb-1 block text-[10.5px] text-ink-3">{label}</span>
              <input
                type={type}
                step="any"
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                className="num h-7 w-full border border-line-2 bg-inset px-2 text-[12px] text-ink outline-none focus:border-accent"
              />
            </label>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-ink-3">The reference facility is simulated at this location.</span>
          <Btn type="submit" disabled={!valid || !changed || busy}>
            Apply
          </Btn>
        </div>
      </form>
    </div>
  );
}

export function TopBar() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const overview = useApp((s) => s.overview);
  const offline = useApp((s) => s.offline);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const now = useNow(20_000);
  // False while the prerendered page hydrates, true afterwards. The clock is
  // left out of the prerendered HTML, which would otherwise carry the build time.
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const weather = overview?.weather;
  const status = sourceStatus(weather);
  const offset = weather?.location.utc_offset_hours ?? 4;
  // While a replay runs, the clock shows the replayed moment, not the wall clock.
  const replayAt = weather?.status === "replay" ? weather.replay_at : null;

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <header className="stage relative z-40 flex h-11 shrink-0 items-stretch border-b border-line bg-panel">
      <div className="flex w-[196px] shrink-0 items-center gap-2.5 border-r border-line px-3.5">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
          <path d="M10 2.2a7.8 7.8 0 107.8 7.8" stroke="var(--color-accent)" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M10 6.2c1.9 2.3 2.9 3.8 2.9 5a2.9 2.9 0 01-5.8 0c0-1.2 1-2.7 2.9-5z" fill="var(--color-accent)" />
          <path d="M17.8 5.2v4.9h-4.9" stroke="var(--color-accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[13.5px] font-semibold tracking-[0.2em] text-ink">COOLLOOP</span>
      </div>

      <nav className="flex shrink-0 items-stretch whitespace-nowrap" aria-label="Sections">
        {TABS.map((tab) => {
          const on = tab.view === view;
          return (
            <button
              key={tab.view}
              onClick={() => setView(tab.view)}
              aria-current={on ? "page" : undefined}
              className={`relative flex items-center gap-2 border-r border-line px-4 text-[13px] font-medium transition-colors ${
                on ? "bg-raised text-ink" : "text-ink-3 hover:bg-raised/60 hover:text-ink-2"
              }`}
            >
              <Icon name={tab.icon} size={14} className={on ? "text-accent" : ""} />
              {tab.label}
              {on && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-accent" />}
            </button>
          );
        })}
      </nav>

      <div className="ml-auto flex items-stretch">
        <div ref={wrap} className="relative flex items-stretch border-l border-line">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className={`flex items-center gap-2.5 whitespace-nowrap px-3.5 text-left transition-colors hover:bg-raised ${open ? "bg-raised" : ""}`}
          >
            <Dot colour={offline ? "var(--color-crit)" : status.colour} pulse={offline || status.pulse} />
            <span className="leading-tight">
              <span className="block text-[11.5px] text-ink">
                {offline ? "Backend offline" : `${weather?.synthetic ? "Synthetic weather" : "Meteomatics"} · ${status.label}`}
              </span>
              <span className="block text-[10.5px] text-ink-3">
                {weather
                  ? `${weather.location.name} · ${replayAt ? dateOnly(replayAt, offset) : `updated ${ago(weather.fetched_at, now)}`}`
                  : "Waiting for data"}
              </span>
            </span>
            <Icon name="chevron" size={11} className={`text-ink-3 transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
          </button>
          {open && <SourcePanel onClose={() => setOpen(false)} />}
        </div>
        <div className="flex items-center whitespace-nowrap border-l border-line px-3.5 leading-tight">
          <span>
            <span className="num block text-[12px] text-ink" style={replayAt ? { color: "var(--color-warn)" } : undefined}>
              {replayAt ? dateClock(replayAt, offset, true) : hydrated ? dateClock(new Date(now), offset) : "–"}
            </span>
            <span className="block text-[10.5px] text-ink-3">
              {replayAt ? "Replayed site time" : "Site time"}, {utcOffsetLabel(offset)}
            </span>
          </span>
        </div>
      </div>
    </header>
  );
}
