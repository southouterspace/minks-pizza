import type { DayHours } from "@/db/schema";

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** US zones offered in Settings; the store's day for stats and history. */
export const STORE_TIMEZONES = [
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Phoenix", label: "Arizona (no DST)" },
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
] as const;

/** "6:45 PM" on the store's clock. */
export function formatClock(d: Date, timeZone: string): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Open/closed per the viewer's local clock (informational, not enforced). */
export function isOpenNow(hours: DayHours[] | null, now = new Date()): boolean | null {
  if (!hours || hours.length === 0) return null;
  const today = hours.find((h) => h.day === now.getDay());
  if (!today || today.closed) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [oh, om] = today.open.split(":").map(Number);
  const [ch, cm] = today.close.split(":").map(Number);
  return minutes >= oh * 60 + om && minutes < ch * 60 + cm;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/** Weekday (0 = Sunday), minutes past midnight and calendar date on `timeZone`'s clock. */
export function zonedParts(d: Date, timeZone: string): { day: number; minutes: number; date: string } {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    partsFormatters.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
    minutes: Number(p.hour) * 60 + Number(p.minute),
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

function offsetMs(instant: number, timeZone: string): number {
  const { date, minutes } = zonedParts(new Date(instant), timeZone);
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d) + minutes * 60_000;
  return wall - Math.floor(instant / 60_000) * 60_000;
}

/** The instant a "YYYY-MM-DD" day begins on `timeZone`'s clock (DST-aware). */
export function zonedDayStart(date: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d);
  const guess = wall - offsetMs(wall, timeZone);
  return new Date(wall - offsetMs(guess, timeZone));
}
