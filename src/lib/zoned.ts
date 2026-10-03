/**
 * Store-timezone calendar math with Intl only. A store-local calendar date is
 * the string "YYYY-MM-DD"; a wall-clock time is "HH:MM". Instants are Dates.
 * Every day and week boundary in staff scheduling and payroll goes through
 * here, so a tablet or server in another zone never shifts a shift.
 */
import { z } from "zod";

export type LocalDate = string;

export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => toUtcDate(s).toISOString().startsWith(s), "Invalid date");

export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

function wallClock(instant: Date, tz: string) {
  const p: Record<string, number> = {};
  for (const part of partsFormatter(tz).formatToParts(instant)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

/** Milliseconds the zone is ahead of UTC at this instant (New York in summer: −4 h). */
function offsetMs(instant: Date, tz: string): number {
  const w = wallClock(instant, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function toUtcDate(date: LocalDate): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const pad = (n: number) => String(n).padStart(2, "0");

export function localDateOf(instant: Date, tz: string): LocalDate {
  const w = wallClock(instant, tz);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** The instant the store's wall clock reads `hhmm` on `date`. */
export function zonedInstant(date: LocalDate, hhmm: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = offsetMs(new Date(guess), tz);
  const instant = guess - first;
  // The guess sat on the other side of a DST change: re-check once.
  const second = offsetMs(new Date(instant), tz);
  return new Date(second === first ? instant : guess - second);
}

export function addDays(date: LocalDate, n: number): LocalDate {
  const d = toUtcDate(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: LocalDate): number {
  return toUtcDate(date).getUTCDay();
}

export function weekStartOf(date: LocalDate, weekStartsOn: number): LocalDate {
  return addDays(date, -((dayOfWeek(date) - weekStartsOn + 7) % 7));
}

export function weekDates(start: LocalDate): LocalDate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function minutesOfDay(instant: Date, tz: string): number {
  const w = wallClock(instant, tz);
  return w.hour * 60 + w.minute;
}

/** "HH:MM" on the store's wall clock, for time inputs. */
export function hhmmOf(instant: Date, tz: string): string {
  const w = wallClock(instant, tz);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** "4:05 PM" on the store's wall clock. */
export function formatClock(instant: Date, tz: string): string {
  let f = clockFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
    clockFormatters.set(tz, f);
  }
  // Newer ICU puts a narrow no-break space before AM/PM.
  return f.format(instant).replace(/ /g, " ");
}

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** "Mon, Oct 6" */
export function formatDay(date: LocalDate): string {
  return dayFormatter.format(toUtcDate(date));
}

/** A shift typed as a date plus wall-clock times; an end at or before the start is the next day. */
export function shiftInstants(
  date: LocalDate,
  startHHMM: string,
  endHHMM: string,
  tz: string,
): { startsAt: Date; endsAt: Date } {
  const endDate = endHHMM <= startHHMM ? addDays(date, 1) : date;
  return { startsAt: zonedInstant(date, startHHMM, tz), endsAt: zonedInstant(endDate, endHHMM, tz) };
}
