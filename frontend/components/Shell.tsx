"use client";

import { useEffect, useRef } from "react";
import { fullClock } from "@/lib/format";
import { useApp, type View } from "@/lib/store";
import type { WeatherBundle } from "@/lib/types";
import { useNow } from "./charts";
import { TopBar } from "./TopBar";
import { TwinHost } from "./twin/TwinViewport";
import { Btn, Icon, Tag } from "./ui";
import DigitalTwin from "./views/DigitalTwin";
import Intelligence from "./views/Intelligence";
import Operations from "./views/Operations";
import Simulation from "./views/Simulation";

const VIEWS: View[] = ["operations", "twin", "simulation", "intelligence"];

function Toast() {
  const toast = useApp((s) => s.toast);
  const clear = useApp((s) => s.clearToast);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(clear, 4200);
    return () => clearTimeout(id);
  }, [toast, clear]);
  if (!toast) return null;
  const colour = toast.kind === "ok" ? "var(--color-teal)" : "var(--color-crit)";
  return (
    <div
      role="status"
      className="stage rise fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2.5 border bg-panel px-3 py-2 text-[12px] text-ink shadow-[0_12px_30px_rgba(28,20,10,0.3)]"
      style={{ borderColor: colour }}
    >
      <Icon name={toast.kind === "ok" ? "check" : "alert"} size={13} className="shrink-0" />
      {toast.text}
    </div>
  );
}

const HOUR = 3_600_000;
const REPLAY_NOTE = "Past Meteomatics weather replayed as if it were now. Not current conditions, and the hours ahead are what followed, not a forecast.";

/** Shown for as long as past weather stands in for the present. It names the
 *  replayed moment and moves it, so a past event can be walked through. */
function ReplayBar({ weather }: { weather: WeatherBundle }) {
  const replay = useApp((s) => s.replay);
  const setWeatherMode = useApp((s) => s.setWeatherMode);
  const busy = useApp((s) => s.busy);
  const now = useNow(60_000);
  if (!weather.replay_at) return null;
  const at = Date.parse(weather.replay_at);
  const quiet = "num h-[22px] border border-line-2 px-2 text-[11px] leading-none text-ink-2 transition-colors hover:border-ink-3 hover:text-ink disabled:opacity-40 disabled:hover:border-line-2 disabled:hover:text-ink-2";
  const step = (hours: number) => (
    <button
      onClick={() => replay(new Date(at + hours * HOUR).toISOString(), false)}
      disabled={busy || at + hours * HOUR > now}
      title={`Move the replayed moment ${Math.abs(hours)} h ${hours < 0 ? "earlier" : "later"}`}
      className={quiet}
    >
      {hours < 0 ? `−${-hours} h` : `+${hours} h`}
    </button>
  );
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-warn/40 bg-warn/[0.07] px-3.5 text-[11.5px]">
      <Tag colour="var(--color-warn)">
        <Icon name="replay" size={11} />
        Replay
      </Tag>
      <div className="flex shrink-0 items-center gap-1.5">
        {step(-6)}
        {step(-1)}
        <span className="num px-1.5 text-ink">{fullClock(weather.replay_at, weather.location.utc_offset_hours)}</span>
        {step(1)}
        {step(6)}
      </div>
      <span className="min-w-0 truncate text-ink-2" title={weather.status === "replay" ? REPLAY_NOTE : undefined}>
        {weather.status === "replay" ? REPLAY_NOTE : "This period could not be retrieved, so nothing is simulated. No substitute data is shown."}
      </span>
      <button onClick={() => setWeatherMode("live")} disabled={busy} className={`${quiet} ml-auto shrink-0 text-ink`} title="Leave the replay and follow the live forecast">
        Back to live
      </button>
    </div>
  );
}

function Startup() {
  const status = useApp((s) => s.overviewStatus);
  const error = useApp((s) => s.overviewError);
  const refresh = useApp((s) => s.refresh);
  return (
    <div className="flex h-full items-center justify-center">
      {status === "error" ? (
        <div className="w-[420px] border border-line-2 bg-panel p-5">
          <div className="label mb-3 text-crit">Disconnected</div>
          <div className="text-[14px] text-ink">The COOLLOOP backend is not answering.</div>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-2">
            {error} Start it from the <span className="num text-ink">backend</span> folder with{" "}
            <span className="num text-ink">uvicorn app.main:app --port 8000</span>. This page retries on its own.
          </p>
          <Btn className="mt-4" onClick={refresh}>
            <Icon name="refresh" size={12} />
            Retry now
          </Btn>
        </div>
      ) : (
        <div className="label pulse">Connecting to the plant model</div>
      )}
    </div>
  );
}

export default function Shell() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const overview = useApp((s) => s.overview);
  const offline = useApp((s) => s.offline);
  const refresh = useApp((s) => s.refresh);
  const loadOptimisation = useApp((s) => s.loadOptimisation);
  const optimisationStatus = useApp((s) => s.optimisationStatus);
  const hasWeather = (overview?.weather.hourly.length ?? 0) > 0;

  // Keep the applied state fresh; retry quickly while the backend is away.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, overview && !offline ? 60_000 : 4_000);
    const onFocus = () => !document.hidden && refresh();
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh, offline, overview === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // The recommendation follows the applied configuration and the forecast:
  // when a new forecast hour or a new weather retrieval arrives, both the
  // recommendation and the briefing are rebuilt.
  const forecastKey = `${overview?.weather.current?.time ?? ""}|${overview?.weather.status ?? ""}|${overview?.weather.location.name ?? ""}`;
  const lastForecastKey = useRef(forecastKey);
  useEffect(() => {
    if (lastForecastKey.current !== forecastKey) {
      const first = lastForecastKey.current === "||";
      lastForecastKey.current = forecastKey;
      if (!first) {
        useApp.setState({ optimisationStatus: "idle", briefingStatus: "idle" });
        return;
      }
    }
    if (hasWeather && optimisationStatus === "idle") loadOptimisation();
  }, [forecastKey, hasWeather, optimisationStatus, loadOptimisation]);

  // The section is part of the URL so a reload or a shared link lands on it.
  useEffect(() => {
    const fromHash = () => {
      const name = window.location.hash.slice(1) as View;
      if (VIEWS.includes(name)) setView(name);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [setView]);
  useEffect(() => {
    const target = view === "operations" ? "" : `#${view}`;
    if (window.location.hash !== target) history.replaceState(null, "", target || window.location.pathname);
  }, [view]);

  return (
    <div className="flex h-dvh min-w-[1180px] flex-col bg-bg">
      <TopBar />
      {offline && overview && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-crit/40 bg-crit/10 px-3.5 text-[11.5px] text-ink">
          <Icon name="alert" size={12} className="text-crit" />
          Backend connection lost. Showing the last values received; retrying.
        </div>
      )}
      {overview?.weather.mode === "replay" && <ReplayBar weather={overview.weather} />}
      <main className="min-h-0 flex-1">
        {!overview ? (
          <Startup />
        ) : view === "operations" ? (
          <Operations />
        ) : view === "twin" ? (
          <DigitalTwin />
        ) : view === "simulation" ? (
          <Simulation />
        ) : (
          <Intelligence />
        )}
      </main>
      <TwinHost />
      <Toast />
    </div>
  );
}
