// Number and time formatting. Times are shown in site-local time, derived
// from the UTC timestamps the backend sends and the site's UTC offset.

const formatters = new Map<number, Intl.NumberFormat>();

export function num(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  let f = formatters.get(digits);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    formatters.set(digits, f);
  }
  // Avoid "-0.0".
  const rounded = Number(value.toFixed(digits));
  return f.format(rounded === 0 ? 0 : rounded);
}

export function signed(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  const text = num(Math.abs(value), digits);
  if (Number(value.toFixed(digits)) === 0) return text;
  return (value > 0 ? "+" : "−") + text;
}

/** Compact magnitude for axis ticks: 950, 1.2K, 43K, 1.3M. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${num(value / 1e6, 1)}M`;
  if (abs >= 1e4) return `${num(value / 1e3, 0)}K`;
  if (abs >= 1e3) return `${num(value / 1e3, 1)}K`;
  return num(value, abs < 10 && !Number.isInteger(value) ? 1 : 0);
}

function shifted(iso: string | Date, offsetHours: number): Date {
  const t = typeof iso === "string" ? new Date(iso) : iso;
  return new Date(t.getTime() + offsetHours * 3_600_000);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

export function clock(iso: string | Date | null | undefined, offsetHours: number): string {
  if (!iso) return "–";
  const d = shifted(iso, offsetHours);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

export function dayClock(iso: string | Date | null | undefined, offsetHours: number): string {
  if (!iso) return "–";
  const d = shifted(iso, offsetHours);
  return `${DAYS[d.getUTCDay()]} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

export function dateClock(iso: string | Date | null | undefined, offsetHours: number, year = false): string {
  if (!iso) return "–";
  const d = shifted(iso, offsetHours);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ""} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** Weekday, date, year and time, for moments that are not this week. */
export function fullClock(iso: string | Date | null | undefined, offsetHours: number): string {
  if (!iso) return "–";
  return `${DAYS[shifted(iso, offsetHours).getUTCDay()]} ${dateClock(iso, offsetHours, true)}`;
}

export function dateOnly(iso: string | Date | null | undefined, offsetHours = 0): string {
  if (!iso) return "–";
  const d = shifted(iso, offsetHours);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Value for a `datetime-local` input that shows site time. */
export function toLocalInput(iso: string | Date, offsetHours: number): string {
  return shifted(iso, offsetHours).toISOString().slice(0, 16);
}

/** UTC timestamp of a `datetime-local` value entered in site time. */
export function fromLocalInput(value: string, offsetHours: number): string | null {
  const t = Date.parse(`${value.slice(0, 16)}:00Z`);
  return Number.isNaN(t) ? null : new Date(t - offsetHours * 3_600_000).toISOString();
}

/** What the weather on screen is, in a few words. */
export function weatherBasis(weather: { synthetic: boolean; status: string }): string {
  if (weather.synthetic) return "synthetic demo profile";
  return weather.status === "replay" ? "replayed Meteomatics history" : "Meteomatics forecast";
}

export function dayLabel(iso: string | Date, offsetHours: number): string {
  const d = shifted(iso, offsetHours);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
}

export function localHour(iso: string | Date, offsetHours: number): number {
  return shifted(iso, offsetHours).getUTCHours();
}

export function utcOffsetLabel(offsetHours: number): string {
  const sign = offsetHours >= 0 ? "+" : "−";
  const abs = Math.abs(offsetHours);
  const h = Math.floor(abs);
  const m = Math.round((abs - h) * 60);
  return `UTC${sign}${h}${m ? `:${two(m)}` : ""}`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
