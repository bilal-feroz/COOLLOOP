import type {
  AmbientOverride,
  Answer,
  AuditEntry,
  Briefing,
  Location,
  OperatingConfig,
  OptimizationResult,
  Overview,
  SimulateResponse,
  WeatherBundle,
  WeatherExtremes,
} from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
  /** The backend process itself could not be reached. */
  get offline() {
    return this.status === 0 || this.status >= 500;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError(0, "The COOLLOOP backend is not reachable.");
  }
  if (!response.ok) {
    let detail = response.statusText || "Request failed";
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") detail = body.detail;
      else if (Array.isArray(body?.detail)) detail = body.detail.map((d: { msg: string }) => d.msg).join("; ");
    } catch {
      if (response.status >= 500) detail = "The COOLLOOP backend is not reachable.";
    }
    throw new ApiError(response.status, detail);
  }
  return response.json() as Promise<T>;
}

const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body), signal });

export const api = {
  overview: (horizonHours = 72) => request<Overview>(`/overview?horizon_hours=${horizonHours}`),
  refreshWeather: () => post<Overview>("/weather/refresh", {}),
  settings: (body: { location?: Location; weather_mode?: WeatherBundle["mode"]; replay_at?: string }) =>
    request<Overview>("/settings", { method: "PUT", body: JSON.stringify(body) }),
  extremes: () => request<WeatherExtremes>("/weather/extremes"),
  simulate: (
    body: { config: OperatingConfig; ambient: AmbientOverride | null; horizon_hours: number; window_hours: number },
    signal?: AbortSignal,
  ) => post<SimulateResponse>("/simulate", body, signal),
  optimize: (
    body: { config?: OperatingConfig; ambient?: AmbientOverride | null; window_hours?: number },
    signal?: AbortSignal,
  ) => post<OptimizationResult>("/optimize", body, signal),
  apply: (body: { config: OperatingConfig; source: string; note?: string; approved_by: string; confirm: true }) =>
    post<Overview>("/config/apply", body),
  reset: (approvedBy: string) => post<Overview>("/config/reset", { approved_by: approvedBy, confirm: true }),
  dismiss: (source: string, approvedBy: string, note = "") =>
    post<AuditEntry[]>("/recommendation/dismiss", { source, approved_by: approvedBy, note }),
  briefing: () => request<Briefing>("/intelligence"),
  ask: (role: Answer["role"], question: string) => post<Answer>("/intelligence/ask", { role, question }),
};
