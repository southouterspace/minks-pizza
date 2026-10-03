import "server-only";
import { and, asc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db, employees, shifts, timeEntries, timeOffRequests } from "@/db";
import { salesByDate } from "@/lib/order-queries";
import {
  atOvertimeRisk,
  ENTRY_FLAGS,
  entryMinutes,
  FLAG_META,
  laborCents,
  laborPercent,
  lateShifts,
  MATCH_EARLY_MS,
  remainingShiftMinutes,
  shiftPaidMinutes,
  type EntryFlag,
  type JobRole,
} from "@/lib/timeclock";
import { addDays, dayBounds, localDateOf, weekBounds, weekStartOf, type LocalDate } from "@/lib/zoned";
import type { StaffConfig } from "@/lib/staff/config";
import { toPayEntry } from "@/lib/staff/queries";
import { getTimesheetWeek } from "@/lib/staff/timesheets";

export type OverviewData = {
  onClock: { entryId: number; employeeName: string; role: JobRole; since: Date; paidMinutes: number; onBreak: boolean }[];
  late: { shiftId: number; employeeName: string; role: JobRole; startsAt: Date }[];
  today: { laborCents: number; salesCents: number; laborPercent: number | null };
  week: {
    scheduledMinutes: number;
    actualMinutes: number;
    otRisk: { employeeId: number; name: string; projectedMinutes: number }[];
  };
  attention: {
    flags: { flag: EntryFlag; count: number }[];
    pendingTimeOff: number;
    unapprovedLastWeek: number;
    lastWeekStart: LocalDate;
  };
};

export async function getOverview(cfg: StaffConfig, now = new Date()): Promise<OverviewData> {
  const tz = cfg.timezone;
  const today = localDateOf(now, tz);
  const day = dayBounds(today, tz);
  const weekStart = weekStartOf(today, cfg.rules.weekStartsOn);
  const week = weekBounds(weekStart, tz);
  const lastWeekStart = addDays(weekStart, -7);
  const lastWeek = weekBounds(lastWeekStart, tz);

  const [open, todayEntries, weekShifts, sales, sheet, [pending], [unapproved]] = await Promise.all([
    db.query.timeEntries.findMany({
      where: isNull(timeEntries.clockOutAt),
      with: { breaks: true, employee: { columns: { name: true, isActive: true } } },
      orderBy: [asc(timeEntries.clockInAt)],
    }),
    // From early enough to catch a punch that belongs to today's first shift.
    db.query.timeEntries.findMany({
      where: and(gte(timeEntries.clockInAt, new Date(day.from.getTime() - MATCH_EARLY_MS)), lt(timeEntries.clockInAt, day.to)),
      with: { breaks: true },
    }),
    db
      .select({ shift: shifts, employeeName: employees.name })
      .from(shifts)
      .innerJoin(employees, eq(employees.id, shifts.employeeId))
      .where(
        and(
          isNotNull(shifts.publishedAt),
          eq(employees.isActive, true),
          gte(shifts.startsAt, week.from),
          lt(shifts.startsAt, week.to),
        ),
      ),
    salesByDate(day.from, day.to, tz),
    getTimesheetWeek(weekStart, cfg, now),
    db.select({ n: sql<number>`count(*)::int` }).from(timeOffRequests).where(eq(timeOffRequests.status, "pending")),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(timeEntries)
      .where(
        and(
          gte(timeEntries.clockInAt, lastWeek.from),
          lt(timeEntries.clockInAt, lastWeek.to),
          isNull(timeEntries.approvedAt),
        ),
      ),
  ]);

  const late = lateShifts(
    weekShifts.map(({ shift, employeeName }) => ({ ...shift, employeeName })),
    todayEntries,
    cfg.rules,
    now,
    tz,
  ).map((s) => ({ shiftId: s.id, employeeName: s.employeeName, role: s.role, startsAt: s.startsAt }));

  const labor = laborCents(
    todayEntries.filter((e) => localDateOf(e.clockInAt, tz) === today).map(toPayEntry),
    now,
  );
  const salesCents = sales.get(today) ?? 0;

  const shiftsOf = Map.groupBy(weekShifts, ({ shift }) => shift.employeeId);
  const otRisk = sheet
    .map((row) => ({
      employeeId: row.employee.id,
      name: row.employee.name,
      projectedMinutes:
        row.pay.totals.paidMinutes +
        remainingShiftMinutes((shiftsOf.get(row.employee.id) ?? []).map(({ shift }) => shift), now),
    }))
    .filter((r) => atOvertimeRisk(r.projectedMinutes, cfg.rules))
    .sort((a, b) => b.projectedMinutes - a.projectedMinutes);

  const flagCounts = new Map<EntryFlag, number>();
  for (const row of sheet) for (const e of row.entries) for (const f of e.flags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);

  return {
    onClock: open
      .filter((e) => e.employee.isActive)
      .map((e) => ({
        entryId: e.id,
        employeeName: e.employee.name,
        role: e.role,
        since: e.clockInAt,
        paidMinutes: entryMinutes(toPayEntry(e), now).paidMinutes,
        onBreak: e.breaks.some((b) => b.endedAt === null),
      })),
    late,
    today: { laborCents: labor, salesCents, laborPercent: laborPercent(labor, salesCents) },
    week: {
      scheduledMinutes: weekShifts.reduce((n, { shift }) => n + shiftPaidMinutes(shift), 0),
      actualMinutes: sheet.reduce((n, row) => n + row.pay.totals.paidMinutes, 0),
      otRisk,
    },
    attention: {
      flags: ENTRY_FLAGS.flatMap((flag) => {
        const count = flagCounts.get(flag);
        return FLAG_META[flag].attention && count ? [{ flag, count }] : [];
      }),
      pendingTimeOff: pending?.n ?? 0,
      unapprovedLastWeek: unapproved?.n ?? 0,
      lastWeekStart,
    },
  };
}
