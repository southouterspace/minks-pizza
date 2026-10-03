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

/** 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/** Indexed by Weekday. */
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** A stored day number (0–6) as a Weekday; anything else falls back. */
export function toWeekday(n: number, fallback: Weekday): Weekday {
  return WEEKDAYS.find((d) => d === n) ?? fallback;
}

/** "16:30" → 990 */
export function hhmmMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

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
  const guess = Date.UTC(y, m - 1, d) + hhmmMinutes(hhmm) * 60_000;
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

export function dayOfWeek(date: LocalDate): Weekday {
  return toUtcDate(date).getUTCDay() as Weekday;
}

export function weekStartOf(date: LocalDate, weekStartsOn: Weekday): LocalDate {
  return addDays(date, -((dayOfWeek(date) - weekStartsOn + 7) % 7));
}

export function weekDates(start: LocalDate): LocalDate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** [00:00 of the first day, 00:00 after the last) on the store's clock. */
function dateBounds(first: LocalDate, days: number, tz: string): { from: Date; to: Date } {
  return { from: zonedInstant(first, "00:00", tz), to: zonedInstant(addDays(first, days), "00:00", tz) };
}

export function dayBounds(date: LocalDate, tz: string): { from: Date; to: Date } {
  return dateBounds(date, 1, tz);
}

export function weekBounds(weekStart: LocalDate, tz: string): { from: Date; to: Date; dates: LocalDate[] } {
  return { ...dateBounds(weekStart, 7, tz), dates: weekDates(weekStart) };
}

/** Today and the `days` after it, as instants. */
export function daysAhead(today: LocalDate, days: number, tz: string): { from: Date; to: Date } {
  return dateBounds(today, days + 1, tz);
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

/** A `datetime-local` value ("2026-10-05T16:00") on the store's wall clock. */
export function toLocalInput(instant: Date, tz: string): string {
  return `${localDateOf(instant, tz)}T${hhmmOf(instant, tz)}`;
}

/** The inverse of `toLocalInput`: blank is null, anything malformed is "invalid". */
export function fromLocalInput(raw: string, tz: string): Date | null | "invalid" {
  if (raw === "") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(raw);
  if (!match || !localDateSchema.safeParse(match[1]).success) return "invalid";
  return zonedInstant(match[1], match[2], tz);
}

/** "16:30" → "4:30 PM", or "4:30p" compact; on the hour drops ":00". */
export function formatHhmm(hhmm: string, { compact = false } = {}): string {
  const minutes = hhmmMinutes(hhmm);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hour = h % 12 === 0 ? 12 : h % 12;
  const time = m === 0 ? `${hour}` : `${hour}:${pad(m)}`;
  if (compact) return `${time}${h < 12 ? "a" : "p"}`;
  return `${time} ${h < 12 ? "AM" : "PM"}`;
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

/** "Mon, Oct 6", or "Mon, Oct 6 to Wed, Oct 8" for a range. */
export function formatDayRange(start: LocalDate, end: LocalDate): string {
  return start === end ? formatDay(start) : `${formatDay(start)} to ${formatDay(end)}`;
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
