import "server-only";
import { and, asc, eq, gte, isNull, lt, ne } from "drizzle-orm";
import { db, employees, shifts, timeOffRequests } from "@/db";
import { salesByDate } from "@/lib/orders";
import {
  availabilityFromStored,
  shiftConflicts,
  shiftCostCents,
  shiftPaidMinutes,
  type EmployeeRole,
  type JobRole,
  type ShiftConflict,
  type WeeklyAvailability,
} from "@/lib/timeclock";
import { addDays, hhmmOf, localDateOf, shiftInstants, weekBounds, zonedInstant, type LocalDate } from "@/lib/zoned";
import type { StaffConfig } from "@/lib/staff/config";
import { ROLE_COLUMNS, toTimeOffView, type TimeOffView } from "@/lib/staff/queries";

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

export type ScheduleEmployee = {
  id: number;
  name: string;
  roles: EmployeeRole[];
  availability: WeeklyAvailability;
  weekMinutes: number;
};

export type ScheduleWeek = {
  weekStart: LocalDate;
  dates: LocalDate[];
  employees: ScheduleEmployee[];
  shifts: ScheduleShift[];
  timeOff: TimeOffView[];
  drafts: number;
  days: { date: LocalDate; minutes: number; costCents: number; forecastCents: number | null }[];
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

  return {
    weekStart,
    dates,
    employees: staff.map((p) => ({
      ...p,
      weekMinutes: (listOf.get(p.id) ?? []).reduce((n, s) => n + s.paidMinutes, 0),
    })),
    shifts: list,
    timeOff,
    drafts: list.filter((s) => !s.published).length,
    days: dates.map((date) => {
      const today = onDate.get(date) ?? [];
      const history = [7, 14, 21, 28].map((n) => sales.get(addDays(date, -n)) ?? 0);
      const total = history.reduce((a, b) => a + b, 0);
      return {
        date,
        minutes: today.reduce((n, s) => n + s.paidMinutes, 0),
        costCents: today.reduce((n, s) => n + s.costCents, 0),
        forecastCents: total === 0 ? null : Math.round(total / history.length),
      };
    }),
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
