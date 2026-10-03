import "server-only";
import { and, asc, eq, gte, isNull, lt, ne } from "drizzle-orm";
import { db, employeeRoles, employees, shifts, timeOffRequests } from "@/db";
import { salesByDate } from "@/lib/order-queries";
import {
  availabilityFromStored,
  isOvertime,
  laborPercent,
  shiftConflicts,
  shiftCostCents,
  shiftPaidMinutes,
  shiftProblem,
  ROLE_LABEL,
  type DayRule,
  type JobRole,
  type ShiftConflict,
} from "@/lib/timeclock";
import { addDays, dayOfWeek, hhmmOf, localDateOf, shiftInstants, weekBounds, zonedInstant, type LocalDate } from "@/lib/zoned";
import type { StaffConfig } from "@/lib/staff/config";
import { ROLE_COLUMNS, toTimeOffView } from "@/lib/staff/queries";

export type ScheduleShift = {
  id: number;
  employeeId: number | null;
  role: JobRole;
  date: LocalDate;
  startsAt: Date;
  endsAt: Date;
  start: string;
  end: string;
  unpaidBreakMinutes: number;
  notes: string | null;
  published: boolean;
  paidMinutes: number;
  costCents: number;
  conflicts: ShiftConflict[];
};

export type ScheduleCell = {
  date: LocalDate;
  shifts: ScheduleShift[];
  /** Approved wins over pending when both cover the day. */
  timeOff: { status: "approved"; reason: string | null } | { status: "pending" } | null;
  /** Null on the open-shifts row. */
  availability: DayRule | null;
};

export type ScheduleRow = {
  /** Null is the open-shifts row. */
  employeeId: number | null;
  name: string;
  /** Scheduled hours this week; null on the open-shifts row. */
  hours: { minutes: number; overtime: boolean } | null;
  cells: ScheduleCell[];
};

export type ScheduleWeek = {
  weekStart: LocalDate;
  dates: LocalDate[];
  rows: ScheduleRow[];
  drafts: number;
  days: { date: LocalDate; minutes: number; costCents: number; forecastCents: number | null; laborPercent: number | null }[];
  totals: { minutes: number; costCents: number };
};

export async function getScheduleWeek(weekStart: LocalDate, cfg: StaffConfig): Promise<ScheduleWeek> {
  const tz = cfg.timezone;
  const { from, to, dates } = weekBounds(weekStart, tz);
  const [people, shiftRows, offRows, sales] = await Promise.all([
    db.query.employees.findMany({
      where: eq(employees.isActive, true),
      columns: { id: true, name: true, availability: true },
      with: { roles: { columns: ROLE_COLUMNS } },
      orderBy: [asc(employees.name)],
    }),
    db.select().from(shifts).where(and(gte(shifts.startsAt, from), lt(shifts.startsAt, to))).orderBy(asc(shifts.startsAt)),
    db
      .select()
      .from(timeOffRequests)
      .where(
        and(
          ne(timeOffRequests.status, "denied"),
          lt(timeOffRequests.startDate, addDays(weekStart, 7)),
          gte(timeOffRequests.endDate, weekStart),
        ),
      ),
    salesByDate(zonedInstant(addDays(weekStart, -28), "00:00", tz), from, tz),
  ]);

  const staff = people.map((p) => ({ ...p, availability: availabilityFromStored(p.availability) }));
  const byId = new Map(staff.map((p) => [p.id, p]));
  const scheduled = shiftRows.filter((s) => s.employeeId === null || byId.has(s.employeeId));
  const timeOff = offRows.map(toTimeOffView);
  const shiftsOf = Map.groupBy(scheduled, (s) => s.employeeId);
  const timeOffOf = Map.groupBy(timeOff, (t) => t.employeeId);

  const list: ScheduleShift[] = scheduled.map((s) => {
    const person = s.employeeId === null ? undefined : byId.get(s.employeeId);
    const rate = person?.roles.find((r) => r.role === s.role)?.hourlyRateCents ?? 0;
    return {
      id: s.id,
      employeeId: s.employeeId,
      role: s.role,
      date: localDateOf(s.startsAt, tz),
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      start: hhmmOf(s.startsAt, tz),
      end: hhmmOf(s.endsAt, tz),
      unpaidBreakMinutes: s.unpaidBreakMinutes,
      notes: s.notes,
      published: s.publishedAt !== null,
      paidMinutes: shiftPaidMinutes(s),
      costCents: shiftCostCents(s, rate),
      conflicts: person
        ? shiftConflicts(s, shiftsOf.get(person.id) ?? [], timeOffOf.get(person.id) ?? [], person.availability, cfg.rules, tz)
        : [],
    };
  });
  const listOf = Map.groupBy(list, (s) => s.employeeId);
  const onDate = Map.groupBy(list, (s) => s.date);

  const cellsOf = (employeeId: number | null, availability: ((date: LocalDate) => DayRule) | null): ScheduleCell[] =>
    dates.map((date) => {
      const mine = (listOf.get(employeeId) ?? []).filter((s) => s.date === date);
      const off = employeeId === null ? [] : (timeOffOf.get(employeeId) ?? []).filter((t) => t.startDate <= date && t.endDate >= date);
      const approved = off.find((t) => t.status === "approved");
      return {
        date,
        shifts: mine,
        timeOff: approved ? { status: "approved", reason: approved.reason } : off.length > 0 ? { status: "pending" } : null,
        availability: availability ? availability(date) : null,
      };
    });

  const rows: ScheduleRow[] = [
    ...staff.map((p) => {
      const minutes = (listOf.get(p.id) ?? []).reduce((n, s) => n + s.paidMinutes, 0);
      return {
        employeeId: p.id,
        name: p.name,
        hours: { minutes, overtime: isOvertime(minutes, cfg.rules) },
        cells: cellsOf(p.id, (date) => p.availability[dayOfWeek(date)]),
      };
    }),
    { employeeId: null, name: "Open shifts", hours: null, cells: cellsOf(null, null) },
  ];

  const days = dates.map((date) => {
    const today = onDate.get(date) ?? [];
    const history = [7, 14, 21, 28].map((n) => sales.get(addDays(date, -n)) ?? 0);
    const total = history.reduce((a, b) => a + b, 0);
    const costCents = today.reduce((n, s) => n + s.costCents, 0);
    const forecastCents = total === 0 ? null : Math.round(total / history.length);
    return {
      date,
      minutes: today.reduce((n, s) => n + s.paidMinutes, 0),
      costCents,
      forecastCents,
      laborPercent: laborPercent(costCents, forecastCents),
    };
  });

  return {
    weekStart,
    dates,
    rows,
    drafts: list.filter((s) => !s.published).length,
    days,
    totals: { minutes: days.reduce((n, d) => n + d.minutes, 0), costCents: days.reduce((n, d) => n + d.costCents, 0) },
  };
}

/**
 * Copies the previous week's shifts into this week as drafts, by store-local
 * date and wall-clock time so DST weeks line up. Running it twice adds
 * nothing: a shift identical to one already there is skipped.
 */
export async function copyPreviousWeek(weekStart: LocalDate, cfg: StaffConfig): Promise<number> {
  const tz = cfg.timezone;
  const prev = weekBounds(addDays(weekStart, -7), tz);
  const cur = weekBounds(weekStart, tz);
  const [source, existing] = await Promise.all([
    db
      .select({
        employeeId: shifts.employeeId,
        role: shifts.role,
        startsAt: shifts.startsAt,
        endsAt: shifts.endsAt,
        unpaidBreakMinutes: shifts.unpaidBreakMinutes,
        notes: shifts.notes,
        active: employees.isActive,
      })
      .from(shifts)
      .leftJoin(employees, eq(employees.id, shifts.employeeId))
      .where(and(gte(shifts.startsAt, prev.from), lt(shifts.startsAt, prev.to))),
    db.select().from(shifts).where(and(gte(shifts.startsAt, cur.from), lt(shifts.startsAt, cur.to))),
  ]);
  const key = (s: { employeeId: number | null; role: string; startsAt: Date; endsAt: Date }) =>
    `${s.employeeId}|${s.role}|${s.startsAt.getTime()}|${s.endsAt.getTime()}`;
  const have = new Set(existing.map(key));
  const copies = source
    .filter((s) => s.employeeId === null || s.active)
    .map((s) => ({
      employeeId: s.employeeId,
      role: s.role,
      unpaidBreakMinutes: s.unpaidBreakMinutes,
      notes: s.notes,
      ...shiftInstants(addDays(localDateOf(s.startsAt, tz), 7), hhmmOf(s.startsAt, tz), hhmmOf(s.endsAt, tz), tz),
    }))
    .filter((s) => !have.has(key(s)));
  if (copies.length > 0) await db.insert(shifts).values(copies);
  return copies.length;
}

export async function publishWeek(weekStart: LocalDate, cfg: StaffConfig): Promise<number> {
  const { from, to } = weekBounds(weekStart, cfg.timezone);
  const published = await db
    .update(shifts)
    .set({ publishedAt: new Date() })
    .where(and(gte(shifts.startsAt, from), lt(shifts.startsAt, to), isNull(shifts.publishedAt)))
    .returning({ id: shifts.id });
  return published.length;
}

export type ShiftInput = {
  shiftId: number | null;
  /** Null is an open shift. */
  employeeId: number | null;
  role: JobRole;
  date: LocalDate;
  start: string;
  end: string;
  unpaidBreakMinutes: number;
  notes: string | null;
};

/**
 * Creates or edits a shift. New shifts are drafts until the week is
 * published; an edit keeps the shift's published state, so staff see the
 * change at once.
 */
export async function saveShift(input: ShiftInput, cfg: StaffConfig): Promise<{ error?: string }> {
  const { shiftId, date, start, end, ...rest } = input;
  if (input.employeeId !== null) {
    const [has] = await db
      .select({ id: employeeRoles.id })
      .from(employeeRoles)
      .where(and(eq(employeeRoles.employeeId, input.employeeId), eq(employeeRoles.role, input.role)));
    if (!has) return { error: `They don't work as ${ROLE_LABEL[input.role]}. Add the role on their profile first.` };
  }
  const values = { ...rest, ...shiftInstants(date, start, end, cfg.timezone), updatedAt: new Date() };
  const problem = shiftProblem(values);
  if (problem) return { error: problem };
  if (shiftId === null) await db.insert(shifts).values(values);
  else await db.update(shifts).set(values).where(eq(shifts.id, shiftId));
  return {};
}

export async function deleteShift(id: number): Promise<void> {
  await db.delete(shifts).where(eq(shifts.id, id));
}
