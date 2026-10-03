/**
 * Store-local time. The server runs in UTC but the store's day starts at its
 * own midnight, so report windows and printed times go through the store's
 * IANA timezone setting.
 */

/** Mink's is in Texas. */
export const DEFAULT_TIMEZONE = "America/Chicago";

/** A "YYYY-MM-DD" calendar date in the store's timezone. */
export type StoreDate = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function parseStoreDate(raw: string | undefined): StoreDate | null {
  const m = raw ? DATE_RE.exec(raw) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCDate() === +m[3] ? raw! : null;
}

function wallClock(at: Date, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour, mi: +parts.minute, s: +parts.second };
}

/** How far the zone's wall clock is ahead of UTC at `at`, in ms. */
function offsetMs(at: Date, tz: string): number {
  const w = wallClock(at, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(at.getTime() / 1000) * 1000;
}

function zonedWallTime(date: StoreDate, minutes: number, tz: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, 0, minutes);
  // Second pass: the offset at the guess can differ from the offset at the
  // answer when a DST change falls between them.
  const first = guess - offsetMs(new Date(guess), tz);
  return new Date(guess - offsetMs(new Date(first), tz));
}

export function addDays(date: StoreDate, days: number): StoreDate {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

/** [store midnight, next store midnight) as instants. */
export function storeDayRange(date: StoreDate, tz: string): { from: Date; to: Date } {
  return { from: zonedWallTime(date, 0, tz), to: zonedWallTime(addDays(date, 1), 0, tz) };
}

/** "18:30": the store's wall clock at `at`, as a time input's value. */
export function storeHhmm(at: Date | string, tz: string): string {
  const w = wallClock(new Date(at), tz);
  return `${String(w.h).padStart(2, "0")}:${String(w.mi).padStart(2, "0")}`;
}

/** The next instant, from `now` on, when the store's clock reads `hhmm`: today, or tomorrow once it has passed. */
export function nextStoreTime(hhmm: string, now: Date, tz: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const today = storeDateOf(now, tz);
  const at = zonedWallTime(today, h * 60 + m, tz);
  return at.getTime() < now.getTime() ? zonedWallTime(addDays(today, 1), h * 60 + m, tz) : at;
}

export function storeDateOf(at: Date, tz: string): StoreDate {
  const w = wallClock(at, tz);
  return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/** "2026-10-03 14:45" in the store's zone: sortable, for CSV. */
export function formatStoreTimestamp(at: Date, tz: string): string {
  const w = wallClock(at, tz);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${p(w.mo)}-${p(w.d)} ${p(w.h)}:${p(w.mi)}`;
}

/** "Oct 3, 2:45 PM" in the store's zone. */
export function formatStoreDateTime(at: Date | string, tz: string): string {
  return new Date(at).toLocaleString("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "2:45 PM" in the store's zone. */
export function formatStoreTime(at: Date | string, tz: string): string {
  return new Date(at).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
}

/** "2:45:07 PM" in the store's zone: for "as of" stamps that change every poll. */
export function formatStoreClock(at: Date | string, tz: string): string {
  return new Date(at).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", second: "2-digit" });
}

/** "Saturday, October 3, 2026" for a store date. */
export function formatStoreDate(date: StoreDate): string {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export const US_TIMEZONES: readonly { tz: string; label: string }[] = [
  { tz: "America/New_York", label: "Eastern" },
  { tz: "America/Chicago", label: "Central" },
  { tz: "America/Denver", label: "Mountain" },
  { tz: "America/Phoenix", label: "Arizona" },
  { tz: "America/Los_Angeles", label: "Pacific" },
  { tz: "America/Anchorage", label: "Alaska" },
  { tz: "Pacific/Honolulu", label: "Hawaii" },
];
