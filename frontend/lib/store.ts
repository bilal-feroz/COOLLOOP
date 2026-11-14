"use client";

import { create } from "zustand";
import { api, ApiError } from "./api";
import type {
  AmbientOverride,
  Briefing,
  Location,
  OperatingConfig,
  OptimizationResult,
  Overview,
  PointResult,
  SimulateResponse,
} from "./types";

export type View = "operations" | "twin" | "simulation" | "intelligence";
export type Fetch = "idle" | "loading" | "ready" | "error";
export type LayerKey = "water" | "heat" | "air" | "labels" | "cutaway";
export type CameraPreset = "overview" | "towers" | "plant" | "hall" | "water";

export const CONDITION_KEYS = ["it_load_kw", "tower_cells_online", "water_allocation_m3_day"] as const;

let simAbort: AbortController | null = null;
let simOptAbort: AbortController | null = null;

interface AppState {
  view: View;
  setView: (view: View) => void;

  // --- applied state ---------------------------------------------------------
  overview: Overview | null;
  overviewStatus: Fetch;
  overviewError: string | null;
  offline: boolean;
  refresh: () => Promise<void>;
  refreshWeather: () => Promise<void>;
  setWeatherMode: (mode: "live" | "demo") => Promise<void>;
  setLocation: (location: Location) => Promise<void>;

  optimisation: OptimizationResult | null;
  optimisationStatus: Fetch;
  optimisationError: string | null;
  loadOptimisation: () => Promise<void>;

  briefing: Briefing | null;
  briefingStatus: Fetch;
  loadBriefing: () => Promise<void>;

  // --- simulation workspace -----------------------------------------------------
  draft: OperatingConfig | null;
  ambientMode: "forecast" | "manual";
  manual: AmbientOverride;
  windowHours: number;
  sim: SimulateResponse | null;
  simStatus: Fetch;
  simError: string | null;
  simOpt: OptimizationResult | null;
  simOptStatus: Fetch;
  simOptError: string | null;
  patchDraft: (patch: Partial<OperatingConfig>) => void;
  loadDraft: (config: OperatingConfig) => void;
  setAmbientMode: (mode: "forecast" | "manual") => void;
  setManual: (patch: Partial<AmbientOverride>) => void;
  setWindowHours: (hours: number) => void;
  runSimulation: () => Promise<void>;
  runSimOptimisation: () => Promise<void>;

  // --- operator decisions ----------------------------------------------------------
  operator: string;
  setOperator: (name: string) => void;
  busy: boolean;
  apply: (config: OperatingConfig, source: string, note?: string) => Promise<boolean>;
  resetConfig: () => Promise<boolean>;
  dismiss: (source: string) => Promise<void>;
  toast: { kind: "ok" | "error"; text: string; at: number } | null;
  clearToast: () => void;

  // --- digital twin UI -----------------------------------------------------------------
  selected: string | null;
  hovered: string | null;
  layers: Record<LayerKey, boolean>;
  preset: { name: CameraPreset; nonce: number };
  select: (id: string | null) => void;
  hover: (id: string | null) => void;
  toggleLayer: (key: LayerKey) => void;
  setPreset: (name: CameraPreset) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

export const useApp = create<AppState>((set, get) => ({
  view: "operations",
  setView: (view) => set({ view, hovered: null }),

  overview: null,
  overviewStatus: "idle",
  overviewError: null,
  offline: false,

  refresh: async () => {
    if (get().overviewStatus === "idle") set({ overviewStatus: "loading" });
    try {
      const overview = await api.overview(72);
      const first = get().draft === null;
      set({
        overview,
        overviewStatus: "ready",
        overviewError: null,
        offline: false,
        ...(first ? { draft: overview.config } : {}),
      });
      if (first && overview.now) {
        set({ manual: { t_db_c: Math.round(overview.now.conditions.t_db_c), rh_pct: Math.round(overview.now.conditions.rh_pct) } });
      }
    } catch (error) {
      const offline = error instanceof ApiError && error.offline;
      set({ overviewStatus: get().overview ? "ready" : "error", overviewError: message(error), offline });
    }
  },

  refreshWeather: async () => {
    set({ busy: true });
    try {
      const overview = await api.refreshWeather();
      set({ overview, optimisation: null, briefing: null, optimisationStatus: "idle", briefingStatus: "idle" });
      const weather = overview.weather;
      set({
        toast:
          weather.status === "live"
            ? { kind: "ok", text: "Weather updated from Meteomatics.", at: Date.now() }
            : weather.status === "demo"
              ? { kind: "ok", text: "Demo dataset reloaded.", at: Date.now() }
              : { kind: "error", text: weather.error?.message ?? "Weather update failed.", at: Date.now() },
      });
    } catch (error) {
      set({ toast: { kind: "error", text: message(error), at: Date.now() } });
    } finally {
      set({ busy: false });
    }
  },

  setWeatherMode: async (mode) => {
    set({ busy: true });
    try {
      const overview = await api.settings({ weather_mode: mode });
      set({
        overview,
        optimisation: null,
        briefing: null,
        optimisationStatus: "idle",
        briefingStatus: "idle",
        sim: null,
        simOpt: null,
        toast: { kind: "ok", text: mode === "demo" ? "Demo mode: synthetic weather." : "Live weather mode.", at: Date.now() },
      });
    } catch (error) {
      set({ toast: { kind: "error", text: message(error), at: Date.now() } });
    } finally {
      set({ busy: false });
    }
  },

  setLocation: async (location) => {
    set({ busy: true });
    try {
      const overview = await api.settings({ location });
      set({
        overview,
        optimisation: null,
        briefing: null,
        optimisationStatus: "idle",
        briefingStatus: "idle",
        sim: null,
        simOpt: null,
        toast: { kind: "ok", text: `Site set to ${location.name}.`, at: Date.now() },
      });
    } catch (error) {
      set({ toast: { kind: "error", text: message(error), at: Date.now() } });
    } finally {
      set({ busy: false });
    }
  },

  optimisation: null,
  optimisationStatus: "idle",
  optimisationError: null,
  loadOptimisation: async () => {
    if (get().optimisationStatus === "loading") return;
    set({ optimisationStatus: "loading", optimisationError: null });
    try {
      set({ optimisation: await api.optimize({}), optimisationStatus: "ready" });
    } catch (error) {
      set({ optimisation: null, optimisationStatus: "error", optimisationError: message(error) });
    }
  },

  briefing: null,
  briefingStatus: "idle",
  loadBriefing: async () => {
    if (get().briefingStatus === "loading") return;
    set({ briefingStatus: "loading" });
    try {
      set({ briefing: await api.briefing(), briefingStatus: "ready" });
    } catch {
      set({ briefingStatus: "error" });
    }
  },

  draft: null,
  ambientMode: "forecast",
  manual: { t_db_c: 40, rh_pct: 30 },
  windowHours: 24,
  sim: null,
  simStatus: "idle",
  simError: null,
  simOpt: null,
  simOptStatus: "idle",
  simOptError: null,

  patchDraft: (patch) => {
    const draft = get().draft;
    if (draft) set({ draft: { ...draft, ...patch } });
  },
  loadDraft: (config) => set({ draft: { ...config } }),
  setAmbientMode: (ambientMode) => set({ ambientMode }),
  setManual: (patch) => set({ manual: { ...get().manual, ...patch } }),
  setWindowHours: (windowHours) => set({ windowHours }),

  runSimulation: async () => {
    const { draft, ambientMode, manual, windowHours } = get();
    if (!draft) return;
    simAbort?.abort();
    const controller = (simAbort = new AbortController());
    set({ simStatus: "loading" });
    try {
      const sim = await api.simulate(
        {
          config: draft,
          ambient: ambientMode === "manual" ? manual : null,
          horizon_hours: Math.max(windowHours, 24),
          window_hours: windowHours,
        },
        controller.signal,
      );
      if (!controller.signal.aborted) set({ sim, simStatus: "ready", simError: null });
    } catch (error) {
      if (controller.signal.aborted) return;
      set({ simStatus: "error", simError: message(error) });
    }
  },

  runSimOptimisation: async () => {
    const { draft, ambientMode, manual, windowHours } = get();
    if (!draft) return;
    simOptAbort?.abort();
    const controller = (simOptAbort = new AbortController());
    set({ simOptStatus: "loading" });
    try {
      const simOpt = await api.optimize(
        { config: draft, ambient: ambientMode === "manual" ? manual : null, window_hours: windowHours },
        controller.signal,
      );
      if (!controller.signal.aborted) set({ simOpt, simOptStatus: "ready", simOptError: null });
    } catch (error) {
      if (controller.signal.aborted) return;
      set({ simOptStatus: "error", simOptError: message(error) });
    }
  },

  operator: "Shift operator",
  setOperator: (operator) => set({ operator }),
  busy: false,
  toast: null,
  clearToast: () => set({ toast: null }),

  apply: async (config, source, note = "") => {
    set({ busy: true });
    try {
      const overview = await api.apply({ config, source, note, approved_by: get().operator || "Operator", confirm: true });
      set({
        overview,
        draft: overview.config,
        optimisation: null,
        briefing: null,
        optimisationStatus: "idle",
        briefingStatus: "idle",
        toast: { kind: "ok", text: "Configuration applied to the simulated facility.", at: Date.now() },
      });
      return true;
    } catch (error) {
      set({ toast: { kind: "error", text: message(error), at: Date.now() } });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  resetConfig: async () => {
    set({ busy: true });
    try {
      const overview = await api.reset(get().operator || "Operator");
      set({
        overview,
        draft: overview.config,
        optimisation: null,
        briefing: null,
        optimisationStatus: "idle",
        briefingStatus: "idle",
        toast: { kind: "ok", text: "Reference baseline restored.", at: Date.now() },
      });
      return true;
    } catch (error) {
      set({ toast: { kind: "error", text: message(error), at: Date.now() } });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  dismiss: async (source) => {
    try {
      const audit = await api.dismiss(source, get().operator || "Operator");
      const briefing = get().briefing;
      if (briefing) set({ briefing: { ...briefing, audit } });
      set({ toast: { kind: "ok", text: "Recommendation dismissed and logged.", at: Date.now() } });
    } catch (error) {
      set({ toast: { kind: "error", text: message(error), at: Date.now() } });
    }
  },

  selected: null,
  hovered: null,
  layers: { water: true, heat: true, air: true, labels: false, cutaway: true },
  preset: { name: "overview", nonce: 0 },
  select: (selected) => set({ selected }),
  hover: (hovered) => {
    if (get().hovered !== hovered) set({ hovered });
  },
  toggleLayer: (key) => set({ layers: { ...get().layers, [key]: !get().layers[key] } }),
  setPreset: (name) => set({ preset: { name, nonce: get().preset.nonce + 1 } }),
}));

/** The operating point the twin should show: the draft in Simulation, the
 *  applied configuration everywhere else. */
export function useTwinPoint(): { point: PointResult | null; source: "applied" | "draft" } {
  const view = useApp((s) => s.view);
  const applied = useApp((s) => s.overview?.now ?? null);
  const draft = useApp((s) => s.sim?.now ?? null);
  if (view === "simulation" && draft) return { point: draft, source: "draft" };
  return { point: applied, source: "applied" };
}

export function useOffset(): number {
  return useApp((s) => s.overview?.weather.location.utc_offset_hours ?? 4);
}
