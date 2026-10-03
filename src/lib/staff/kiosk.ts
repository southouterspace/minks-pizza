import "server-only";
import { and, asc, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import { db, employees, timeBreaks, timeEntries, timeOffRequests } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import {
  checkClockIn,
  computeWeek,
  defaultRoleOf,
  entryMinutes,
  kioskShiftDays,
  matchShift,
  planClock,
  remainingShiftMinutes,
  REPLAY_MESSAGE,
  ROLE_LABEL,
  timeOffProblem,
  type ClockState,
  type ClockStep,
  type EmployeeRole,
  type KioskAction,
  type KioskBoard,
  type KioskResponse,
  type KioskView,
  type ShiftSummary,
} from "@/lib/timeclock";
import { daysAhead, formatClock, formatDayRange, localDateOf, weekBounds, weekStartOf } from "@/lib/zoned";
import type { StaffConfig } from "@/lib/staff/config";
import { pinDigest } from "@/lib/staff/employees";
import {
  openEntryOf,
  publishedShiftsNear,
  publishedShiftsOf,
  ROLE_COLUMNS,
  toKioskShift,
  toPayEntry,
  toTimeOffView,
  type EntryRow,
} from "@/lib/staff/queries";
import { requestTimeOff } from "@/lib/staff/time-off";

export type KioskEmployee = { id: number; name: string; roles: [EmployeeRole, ...EmployeeRole[]] };

/** Archived employees, employees without a PIN and employees without a role can't use the clock. */
export async function employeeByPin(pin: string): Promise<KioskEmployee | null> {
  const row = await db.query.employees.findFirst({
    where: and(eq(employees.pinDigest, pinDigest(pin)), eq(employees.isActive, true)),
    columns: { id: true, name: true },
    with: { roles: { columns: ROLE_COLUMNS } },
  });
  const [first, ...rest] = row?.roles ?? [];
  if (!row || !first) return null;
  return { id: row.id, name: row.name, roles: [first, ...rest] };
}

export async function getKioskBoard(cfg: StaffConfig): Promise<KioskBoard> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(timeEntries)
    .innerJoin(employees, eq(employees.id, timeEntries.employeeId))
    .where(and(isNull(timeEntries.clockOutAt), eq(employees.isActive, true)));
  return { serverNow: new Date().toISOString(), timezone: cfg.timezone, onClock: row?.n ?? 0 };
}

function clockStateOf(open: EntryRow | undefined): ClockState {
  if (!open) return { kind: "off" };
  const onBreak = open.breaks.find((b) => b.endedAt === null);
  if (onBreak) {
    return { kind: "on_break", entryId: open.id, breakId: onBreak.id, paid: onBreak.paid, since: onBreak.startedAt.toISOString() };
  }
  return { kind: "working", entryId: open.id, role: open.role, since: open.clockInAt.toISOString() };
}

export async function getKioskView(employee: KioskEmployee, cfg: StaffConfig, now = new Date()): Promise<KioskView> {
  const tz = cfg.timezone;
  const today = localDateOf(now, tz);
  const week = weekBounds(weekStartOf(today, cfg.rules.weekStartsOn), tz);
  const horizon = daysAhead(today, 7, tz);

  const [open, weekEntries, shiftRows, offRows] = await Promise.all([
    openEntryOf(employee.id),
    db.query.timeEntries.findMany({
      where: and(
        eq(timeEntries.employeeId, employee.id),
        gte(timeEntries.clockInAt, week.from),
        lt(timeEntries.clockInAt, week.to),
      ),
      with: { breaks: true },
    }),
    publishedShiftsOf(
      employee.id,
      new Date(Math.min(horizon.from.getTime(), week.from.getTime())),
      new Date(Math.max(horizon.to.getTime(), week.to.getTime())),
    ),
    db
      .select()
      .from(timeOffRequests)
      .where(
        and(
          eq(timeOffRequests.employeeId, employee.id),
          gte(timeOffRequests.endDate, today),
          ne(timeOffRequests.status, "denied"),
        ),
      )
      .orderBy(asc(timeOffRequests.startDate)),
  ]);

  const pay = computeWeek(weekEntries.map(toPayEntry), cfg.rules, tz, now);
  const stillAhead = remainingShiftMinutes(
    shiftRows.filter((s) => s.startsAt >= week.from && s.startsAt < week.to),
    now,
  );
  const days = kioskShiftDays(shiftRows, today, tz);

  return {
    employee: { id: employee.id, name: employee.name, roles: employee.roles.map((r) => r.role) },
    state: clockStateOf(open),
    defaultRole: defaultRoleOf(employee.roles, matchShift(now, shiftRows)),
    todayShifts: days.today.map(toKioskShift),
    upcoming: days.upcoming.map(toKioskShift),
    week: { paidMinutes: pay.totals.paidMinutes, projectedMinutes: pay.totals.paidMinutes + stillAhead },
    current: open ? entryMinutes(toPayEntry(open), now) : null,
    timeOff: offRows.map(toTimeOffView).map(({ id, startDate, endDate, status }) => ({ id, startDate, endDate, status })),
  };
}

type StepOutcome =
  | { kind: "done"; message: string; summary: ShiftSummary | null }
  /** Another tablet got there first; the database refused a second row. */
  | { kind: "lost_race" }
  | { kind: "refused"; message: string };

const done = (message: string, summary: ShiftSummary | null = null): StepOutcome => ({ kind: "done", message, summary });

const LOST_RACE: StepOutcome = { kind: "lost_race" };

/** Runs an insert a partial unique index guards; true when the index refused it. */
async function lostRace(insert: Promise<unknown>): Promise<boolean> {
  try {
    await insert;
    return false;
  } catch (error) {
    if (isUniqueViolation(error)) return true;
    throw error;
  }
}

async function runStep(step: ClockStep, employee: KioskEmployee, now: Date, cfg: StaffConfig): Promise<StepOutcome> {
  const tz = cfg.timezone;
  switch (step.type) {
    case "clock_in": {
      const nearby = await publishedShiftsNear(employee.id, now);
      const check = checkClockIn(employee.roles, step.role, nearby, cfg.rules, now, tz);
      if (!check.ok) return { kind: "refused", message: check.message };
      const raced = await lostRace(
        db.insert(timeEntries).values({
          employeeId: employee.id,
          shiftId: matchShift(now, nearby)?.id ?? null,
          role: step.role,
          hourlyRateCents: check.rateCents,
          clockInAt: now,
          source: "kiosk",
        }),
      );
      return raced ? LOST_RACE : done(`Clocked in ${formatClock(now, tz)} as ${ROLE_LABEL[step.role]}`);
    }
    case "start_break": {
      const raced = await lostRace(
        db.insert(timeBreaks).values({ timeEntryId: step.entryId, startedAt: now, paid: step.paid }),
      );
      return raced ? LOST_RACE : done(`${step.paid ? "Paid" : "Unpaid"} break started ${formatClock(now, tz)}`);
    }
    case "end_break": {
      // A second tablet ending the same break still leaves it ended, so both answer success.
      await db
        .update(timeBreaks)
        .set({ endedAt: now })
        .where(and(eq(timeBreaks.id, step.breakId), isNull(timeBreaks.endedAt)));
      return done(`Break ended ${formatClock(now, tz)}. You're back on the clock.`);
    }
    case "clock_out": {
      const [[closed], breaks] = await db.batch([
        db
          .update(timeEntries)
          .set({ clockOutAt: now, declaredTipsCents: step.declaredTipsCents, updatedAt: now })
          .where(and(eq(timeEntries.id, step.entryId), isNull(timeEntries.clockOutAt)))
          .returning({ clockInAt: timeEntries.clockInAt }),
        db.select().from(timeBreaks).where(eq(timeBreaks.timeEntryId, step.entryId)),
      ]);
      if (!closed) return LOST_RACE;
      const minutes = entryMinutes({ clockInAt: closed.clockInAt, clockOutAt: now, breaks }, now);
      return done(`Clocked out ${formatClock(now, tz)}`, {
        clockInAt: closed.clockInAt.toISOString(),
        clockOutAt: now.toISOString(),
        ...minutes,
        declaredTipsCents: step.declaredTipsCents,
      });
    }
  }
}

/**
 * Applies one kiosk action and answers with the fresh view. Each action is
 * checked against the clock's current state, so a double tap or a retry is a
 * replay that returns the view; the partial unique indexes catch the races
 * the state check can't (two tablets at once).
 */
export async function applyKioskAction(
  employee: KioskEmployee,
  action: KioskAction,
  cfg: StaffConfig,
): Promise<KioskResponse> {
  const now = new Date();
  const respond = async (
    message: string,
    tone: KioskResponse["tone"],
    summary: KioskResponse["summary"] = null,
  ): Promise<KioskResponse> => ({ view: await getKioskView(employee, cfg), message, tone, summary });

  if (action.type === "request_time_off") {
    const problem = timeOffProblem(action.startDate, action.endDate, localDateOf(now, cfg.timezone));
    if (problem) return respond(problem, "error");
    await requestTimeOff({
      employeeId: employee.id,
      startDate: action.startDate,
      endDate: action.endDate,
      reason: action.reason || null,
      decidedBy: null,
    });
    return respond(`Time off requested for ${formatDayRange(action.startDate, action.endDate)}. A manager will review it.`, "success");
  }

  const plan = planClock(clockStateOf(await openEntryOf(employee.id)), action);
  if (plan.kind !== "apply") return respond(plan.message, plan.kind === "replay" ? "info" : "error");
  const outcome = await runStep(plan.step, employee, now, cfg);
  switch (outcome.kind) {
    case "lost_race":
      return respond(REPLAY_MESSAGE[action.type], "info");
    case "refused":
      return respond(outcome.message, "error");
    case "done":
      return respond(outcome.message, "success", outcome.summary);
  }
}
