import "server-only";
import { createHmac, randomInt } from "node:crypto";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import {
  db,
  employees,
  orders,
  shifts,
  storeSettings,
  timeBreaks,
  timeEntries,
  timeEntryAudit,
  timeOffRequests,
} from "@/db";
import {
  computeWeek,
  DEFAULT_STAFF_RULES,
  earlyClockInBlock,
  ENTRY_FLAGS,
  entryFlags,
  entryMinutes,
  matchShift,
  planClock,
  punchProblem,
  remainingShiftMinutes,
  ROLE_LABEL,
  shiftConflicts,
  shiftCostCents,
  shiftPaidMinutes,
  type AuditSnapshot,
  type ClockState,
  type EntryFlag,
  type JobRole,
  type KioskAction,
  type KioskBoard,
  type KioskResponse,
  type KioskShift,
  type KioskView,
  type PayBreak,
  type PayEntry,
  type ShiftConflict,
  type StaffRules,
  type WeekPay,
  type WeeklyAvailability,
} from "@/lib/timeclock";
import {
  addDays,
  formatClock,
  formatDay,
  hhmmOf,
  localDateOf,
  localDateSchema,
  shiftInstants,
  weekDates,
  weekStartOf,
  zonedInstant,
  type LocalDate,
} from "@/lib/zoned";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ---------------------------------------------------------------------------
// Store config
// ---------------------------------------------------------------------------

export type StaffConfig = { storeName: string; timezone: string; rules: StaffRules };

export async function getStaffConfig(): Promise<StaffConfig> {
  const [row] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
  if (!row) return { storeName: "Mink's Pizza", timezone: "America/New_York", rules: DEFAULT_STAFF_RULES };
  return {
    storeName: row.name,
    timezone: row.timezone,
    rules: {
      weekStartsOn: row.weekStartsOn,
      otWeeklyMinutes: row.otWeeklyMinutes,
      otDailyMinutes: row.otDailyMinutes,
      dtDailyMinutes: row.dtDailyMinutes,
      breakRequiredAfterMinutes: row.breakRequiredAfterMinutes,
      clockGraceMinutes: row.clockGraceMinutes,
      earlyClockInMinutes: row.earlyClockInMinutes,
    },
  };
}

/** `?week=` snapped to the store's payroll week start; anything unparsable is this week. */
export function resolveWeek(param: unknown, cfg: StaffConfig, now = new Date()): LocalDate {
  const parsed = localDateSchema.safeParse(param);
  return weekStartOf(parsed.success ? parsed.data : localDateOf(now, cfg.timezone), cfg.rules.weekStartsOn);
}

export function weekRange(weekStart: LocalDate, tz: string) {
  return {
    from: zonedInstant(weekStart, "00:00", tz),
    to: zonedInstant(addDays(weekStart, 7), "00:00", tz),
    dates: weekDates(weekStart),
  };
}

function dayRange(date: LocalDate, tz: string) {
  return { from: zonedInstant(date, "00:00", tz), to: zonedInstant(addDays(date, 1), "00:00", tz) };
}

// ---------------------------------------------------------------------------
// PINs
// ---------------------------------------------------------------------------

export function pinDigest(pin: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return createHmac("sha256", secret).update(`pin:${pin}`).digest("hex");
}

/** A random 4-digit PIN nobody else has. */
export async function generatePin(): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pin = String(randomInt(0, 10_000)).padStart(4, "0");
    const [taken] = await db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.pinDigest, pinDigest(pin)));
    if (!taken) return pin;
  }
  throw new Error("Couldn't find a free PIN");
}

/** Postgres unique_violation, possibly wrapped by drizzle. */
export function isUniqueViolation(error: unknown): boolean {
  for (let e = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type EntryRow = typeof timeEntries.$inferSelect & { breaks: (typeof timeBreaks.$inferSelect)[] };

function toPayEntry(e: EntryRow): PayEntry {
  return {
    id: e.id,
    role: e.role,
    rateCents: e.hourlyRateCents,
    clockInAt: e.clockInAt,
    clockOutAt: e.clockOutAt,
    breaks: e.breaks.map((b) => ({ startedAt: b.startedAt, endedAt: b.endedAt, paid: b.paid })),
    declaredTipsCents: e.declaredTipsCents,
  };
}

function snapshotOf(e: EntryRow): AuditSnapshot {
  return {
    role: e.role,
    rateCents: e.hourlyRateCents,
    clockInAt: e.clockInAt.toISOString(),
    clockOutAt: e.clockOutAt?.toISOString() ?? null,
    declaredTipsCents: e.declaredTipsCents,
    note: e.note,
    breaks: e.breaks
      .toSorted((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .map((b) => ({ startedAt: b.startedAt.toISOString(), endedAt: b.endedAt?.toISOString() ?? null, paid: b.paid })),
  };
}

function clockStateOf(open: EntryRow | undefined): ClockState {
  if (!open) return { kind: "off" };
  const onBreak = open.breaks.find((b) => b.endedAt === null);
  if (onBreak) {
    return {
      kind: "on_break",
      entryId: open.id,
      breakId: onBreak.id,
      paid: onBreak.paid,
      since: onBreak.startedAt.toISOString(),
      shiftSince: open.clockInAt.toISOString(),
    };
  }
  return { kind: "working", entryId: open.id, role: open.role, since: open.clockInAt.toISOString() };
}

function openEntryOf(employeeId: number) {
  return db.query.timeEntries.findFirst({
    where: and(eq(timeEntries.employeeId, employeeId), isNull(timeEntries.clockOutAt)),
    with: { breaks: true },
  });
}

function publishedShiftsOf(employeeId: number, from: Date, to: Date) {
  return db
    .select()
    .from(shifts)
    .where(
      and(
        eq(shifts.employeeId, employeeId),
        isNotNull(shifts.publishedAt),
        gte(shifts.endsAt, from),
        lt(shifts.startsAt, to),
      ),
    )
    .orderBy(asc(shifts.startsAt));
}

// ---------------------------------------------------------------------------
// Kiosk
// ---------------------------------------------------------------------------

export type KioskEmployee = { id: number; name: string; roles: { role: JobRole; hourlyRateCents: number; isPrimary: boolean }[] };

/** Archived employees and employees without a PIN can't use the clock. */
export async function employeeByPin(pin: string): Promise<KioskEmployee | null> {
  const row = await db.query.employees.findFirst({
    where: and(eq(employees.pinDigest, pinDigest(pin)), eq(employees.isActive, true)),
    columns: { id: true, name: true },
    with: { roles: { columns: { role: true, hourlyRateCents: true, isPrimary: true } } },
  });
  return row ?? null;
}

export async function getKioskBoard(cfg: StaffConfig): Promise<KioskBoard> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(timeEntries)
    .innerJoin(employees, eq(employees.id, timeEntries.employeeId))
    .where(and(isNull(timeEntries.clockOutAt), eq(employees.isActive, true)));
  return { serverNow: new Date().toISOString(), timezone: cfg.timezone, onClock: row?.n ?? 0 };
}

function toKioskShift(s: typeof shifts.$inferSelect): KioskShift {
  return {
    id: s.id,
    role: s.role,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    unpaidBreakMinutes: s.unpaidBreakMinutes,
  };
}

function defaultRoleOf(employee: KioskEmployee, matched: { role: JobRole } | null): JobRole {
  if (matched && employee.roles.some((r) => r.role === matched.role)) return matched.role;
  return (employee.roles.find((r) => r.isPrimary) ?? employee.roles[0])?.role ?? "cook";
}

export async function getKioskView(employee: KioskEmployee, cfg: StaffConfig, now = new Date()): Promise<KioskView> {
  const tz = cfg.timezone;
  const today = localDateOf(now, tz);
  const week = weekRange(weekStartOf(today, cfg.rules.weekStartsOn), tz);
  const horizon = { from: zonedInstant(today, "00:00", tz), to: zonedInstant(addDays(today, 8), "00:00", tz) };

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

  return {
    employee: { id: employee.id, name: employee.name, roles: employee.roles.map((r) => r.role) },
    state: clockStateOf(open),
    defaultRole: defaultRoleOf(employee, matchShift(now, shiftRows)),
    todayShifts: shiftRows.filter((s) => localDateOf(s.startsAt, tz) === today).map(toKioskShift),
    upcoming: shiftRows
      .filter((s) => {
        const d = localDateOf(s.startsAt, tz);
        return d > today && d <= addDays(today, 7);
      })
      .map(toKioskShift),
    week: { paidMinutes: pay.totals.paidMinutes, projectedMinutes: pay.totals.paidMinutes + stillAhead },
    current: open ? entryMinutes(toPayEntry(open), now) : null,
    timeOff: offRows.map((t) => ({
      id: t.id,
      startDate: t.startDate,
      endDate: t.endDate,
      status: t.status === "approved" ? "approved" : "pending",
    })),
  };
}

function rangeLabel(start: LocalDate, end: LocalDate): string {
  return start === end ? formatDay(start) : `${formatDay(start)} to ${formatDay(end)}`;
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
  const tz = cfg.timezone;
  const now = new Date();
  const respond = async (
    message: string,
    tone: KioskResponse["tone"],
    summary: KioskResponse["summary"] = null,
  ): Promise<KioskResponse> => ({ view: await getKioskView(employee, cfg), message, tone, summary });

  if (action.type === "request_time_off") {
    const today = localDateOf(now, tz);
    if (action.startDate < today) return respond("Time off has to start today or later.", "error");
    if (action.endDate < action.startDate) return respond("The last day can't be before the first.", "error");
    await requestTimeOff({
      employeeId: employee.id,
      startDate: action.startDate,
      endDate: action.endDate,
      reason: action.reason || null,
      decidedBy: null,
    });
    return respond(`Time off requested for ${rangeLabel(action.startDate, action.endDate)}. A manager will review it.`, "success");
  }

  const open = await openEntryOf(employee.id);
  const state = clockStateOf(open);
  const plan = planClock(state, action);
  if (plan.kind !== "apply") return respond(plan.message, plan.kind === "replay" ? "info" : "error");

  switch (action.type) {
    case "clock_in": {
      const role = employee.roles.find((r) => r.role === action.role);
      if (!role) return respond("Pick one of your roles. A manager can add roles for you.", "error");
      const nearby = await publishedShiftsOf(employee.id, new Date(now.getTime() - 14 * HOUR), new Date(now.getTime() + 24 * HOUR));
      const block = earlyClockInBlock(now, nearby, cfg.rules, tz);
      if (block) {
        return respond(
          `Your shift starts at ${formatClock(block.shift.startsAt, tz)}. You can clock in from ${formatClock(block.opensAt, tz)}.`,
          "error",
        );
      }
      try {
        await db.insert(timeEntries).values({
          employeeId: employee.id,
          shiftId: matchShift(now, nearby)?.id ?? null,
          role: role.role,
          hourlyRateCents: role.hourlyRateCents,
          clockInAt: now,
          source: "kiosk",
        });
      } catch (error) {
        if (isUniqueViolation(error)) return respond("You're already clocked in.", "info");
        throw error;
      }
      return respond(`Clocked in ${formatClock(now, tz)} as ${ROLE_LABEL[role.role]}`, "success");
    }
    case "start_break": {
      if (state.kind !== "working") break;
      try {
        await db.insert(timeBreaks).values({ timeEntryId: state.entryId, startedAt: now, paid: action.paid });
      } catch (error) {
        if (isUniqueViolation(error)) return respond("You're already on a break.", "info");
        throw error;
      }
      return respond(`${action.paid ? "Paid" : "Unpaid"} break started ${formatClock(now, tz)}`, "success");
    }
    case "end_break": {
      if (state.kind !== "on_break") break;
      await db
        .update(timeBreaks)
        .set({ endedAt: now })
        .where(and(eq(timeBreaks.id, state.breakId), isNull(timeBreaks.endedAt)));
      return respond(`Break ended ${formatClock(now, tz)}. You're back on the clock.`, "success");
    }
    case "clock_out": {
      if (state.kind !== "working" || !open) break;
      const [closed] = await db
        .update(timeEntries)
        .set({ clockOutAt: now, declaredTipsCents: action.declaredTipsCents, updatedAt: now })
        .where(and(eq(timeEntries.id, state.entryId), isNull(timeEntries.clockOutAt)))
        .returning({ id: timeEntries.id });
      if (!closed) return respond("You're already clocked out.", "info");
      const minutes = entryMinutes({ ...toPayEntry(open), clockOutAt: now }, now);
      return respond(`Clocked out ${formatClock(now, tz)}`, "success", {
        clockInAt: open.clockInAt.toISOString(),
        clockOutAt: now.toISOString(),
        ...minutes,
        declaredTipsCents: action.declaredTipsCents,
      });
    }
  }
  return respond("That didn't go through. Try again.", "error");
}

/**
 * Files a time-off request. With `decidedBy` (a manager adding it) it is
 * approved on the spot. Re-sending the same dates returns the existing request.
 */
export async function requestTimeOff(input: {
  employeeId: number;
  startDate: LocalDate;
  endDate: LocalDate;
  reason: string | null;
  decidedBy: number | null;
}): Promise<void> {
  const [existing] = await db
    .select({ id: timeOffRequests.id, status: timeOffRequests.status })
    .from(timeOffRequests)
    .where(
      and(
        eq(timeOffRequests.employeeId, input.employeeId),
        eq(timeOffRequests.startDate, input.startDate),
        eq(timeOffRequests.endDate, input.endDate),
        ne(timeOffRequests.status, "denied"),
      ),
    );
  const byManager = input.decidedBy !== null;
  if (existing) {
    if (byManager && existing.status === "pending") {
      await decideTimeOff(existing.id, "approved", input.decidedBy!);
    }
    return;
  }
  await db.insert(timeOffRequests).values({
    employeeId: input.employeeId,
    startDate: input.startDate,
    endDate: input.endDate,
    reason: input.reason,
    status: byManager ? "approved" : "pending",
    source: byManager ? "manager" : "kiosk",
    decidedBy: input.decidedBy,
    decidedAt: byManager ? new Date() : null,
  });
}

export async function decideTimeOff(id: number, status: "approved" | "denied", operatorId: number): Promise<void> {
  await db
    .update(timeOffRequests)
    .set({ status, decidedBy: operatorId, decidedAt: new Date() })
    .where(and(eq(timeOffRequests.id, id), eq(timeOffRequests.status, "pending")));
}

// ---------------------------------------------------------------------------
// Timesheets
// ---------------------------------------------------------------------------

export type TimesheetEntry = {
  id: number;
  date: LocalDate;
  role: JobRole;
  rateCents: number;
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks: { id: number; startedAt: Date; endedAt: Date | null; paid: boolean }[];
  declaredTipsCents: number;
  note: string | null;
  source: "kiosk" | "manager";
  approvedAt: Date | null;
  paidMinutes: number;
  breakMinutes: number;
  flags: EntryFlag[];
  shift: { startsAt: Date; endsAt: Date } | null;
  audit: { id: number; action: string; reason: string | null; at: Date; operatorName: string | null }[];
};

export type TimesheetRow = {
  employee: { id: number; name: string; isActive: boolean };
  entries: TimesheetEntry[];
  pay: WeekPay;
  /** Payroll pay: closed punches only. */
  closedPay: WeekPay;
  flagCount: number;
  hasOpen: boolean;
  approved: boolean;
};

const EDIT_ACTIONS = new Set(["create", "edit", "clock_out"]);

export async function getTimesheetWeek(weekStart: LocalDate, cfg: StaffConfig, now = new Date()): Promise<TimesheetRow[]> {
  const tz = cfg.timezone;
  const { from, to } = weekRange(weekStart, tz);
  const [rows, people] = await Promise.all([
    db.query.timeEntries.findMany({
      where: and(gte(timeEntries.clockInAt, from), lt(timeEntries.clockInAt, to)),
      with: {
        breaks: true,
        shift: { columns: { startsAt: true, endsAt: true } },
        audit: { with: { operator: { columns: { name: true } } } },
      },
      orderBy: [asc(timeEntries.clockInAt)],
    }),
    db
      .select({ id: employees.id, name: employees.name, isActive: employees.isActive })
      .from(employees)
      .orderBy(asc(employees.name)),
  ]);

  return people
    .map((employee) => {
      const mine = rows.filter((r) => r.employeeId === employee.id);
      const pay = computeWeek(mine.map(toPayEntry), cfg.rules, tz, now);
      const minutes = new Map(pay.entries.map((e) => [e.id, e]));
      const entries: TimesheetEntry[] = mine.map((r) => {
        const audit = r.audit
          .toSorted((a, b) => a.at.getTime() - b.at.getTime())
          .map((a) => ({ id: a.id, action: a.action, reason: a.reason, at: a.at, operatorName: a.operator?.name ?? null }));
        const m = minutes.get(r.id)!;
        return {
          id: r.id,
          date: m.date,
          role: r.role,
          rateCents: r.hourlyRateCents,
          clockInAt: r.clockInAt,
          clockOutAt: r.clockOutAt,
          breaks: r.breaks.toSorted((a, b) => a.startedAt.getTime() - b.startedAt.getTime()),
          declaredTipsCents: r.declaredTipsCents,
          note: r.note,
          source: r.source,
          approvedAt: r.approvedAt,
          paidMinutes: m.paidMinutes,
          breakMinutes: m.breakMinutes,
          flags: entryFlags(
            { ...toPayEntry(r), edited: audit.some((a) => EDIT_ACTIONS.has(a.action)) },
            r.shift,
            cfg.rules,
            now,
          ),
          shift: r.shift,
          audit,
        };
      });
      return {
        employee,
        entries,
        pay,
        closedPay: computeWeek(mine.filter((r) => r.clockOutAt !== null).map(toPayEntry), cfg.rules, tz, now),
        flagCount: entries.reduce((n, e) => n + e.flags.length, 0),
        hasOpen: entries.some((e) => e.clockOutAt === null),
        approved: entries.length > 0 && entries.every((e) => e.approvedAt !== null),
      };
    })
    .filter((row) => row.employee.isActive || row.entries.length > 0);
}

function csvCell(value: string | number): string {
  let s = String(value);
  // A leading = + - @ makes spreadsheets evaluate the cell.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);
const hours = (minutes: number) => (minutes / 60).toFixed(2);

/**
 * Payroll export: one `entry` line per closed punch, then one `total` line
 * per employee, in one rectangular table so it imports anywhere.
 */
export function timesheetCsv(rows: TimesheetRow[], tz: string): string {
  const stamp = (d: Date) => `${localDateOf(d, tz)} ${hhmmOf(d, tz)}`;
  const lines: (string | number)[][] = [
    ["Line", "Employee", "Role", "Date", "In", "Out", "Unpaid break (min)", "Paid hours", "Rate", "Tips", "Regular hours", "OT hours", "DT hours", "Gross"],
  ];
  for (const row of rows) {
    for (const e of row.entries) {
      if (e.clockOutAt === null) continue;
      lines.push([
        "entry",
        row.employee.name,
        ROLE_LABEL[e.role],
        e.date,
        stamp(e.clockInAt),
        stamp(e.clockOutAt),
        e.breakMinutes,
        hours(e.paidMinutes),
        dollars(e.rateCents),
        dollars(e.declaredTipsCents),
        "",
        "",
        "",
        "",
      ]);
    }
  }
  for (const row of rows) {
    if (row.closedPay.entries.length === 0) continue;
    const t = row.closedPay.totals;
    lines.push([
      "total",
      row.employee.name,
      "",
      "",
      "",
      "",
      t.breakMinutes,
      hours(t.paidMinutes),
      "",
      dollars(row.closedPay.tipsCents),
      hours(t.regularMinutes),
      hours(t.otMinutes),
      hours(t.dtMinutes),
      dollars(row.closedPay.grossCents),
    ]);
  }
  return lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Manager edits to time (every one audited with a reason)
// ---------------------------------------------------------------------------

function entryWithBreaks(id: number) {
  return db.query.timeEntries.findFirst({ where: eq(timeEntries.id, id), with: { breaks: true } });
}

/** Closes a punch someone forgot, ending any open break at the same moment. */
export async function managerClockOut(entryId: number, operatorId: number, reason: string): Promise<void> {
  const entry = await entryWithBreaks(entryId);
  if (!entry || entry.clockOutAt !== null) return;
  const now = new Date();
  const after: EntryRow = {
    ...entry,
    clockOutAt: now,
    breaks: entry.breaks.map((b) => (b.endedAt === null ? { ...b, endedAt: now } : b)),
  };
  await db.batch([
    db.update(timeBreaks).set({ endedAt: now }).where(and(eq(timeBreaks.timeEntryId, entryId), isNull(timeBreaks.endedAt))),
    db
      .update(timeEntries)
      .set({ clockOutAt: now, updatedAt: now })
      .where(and(eq(timeEntries.id, entryId), isNull(timeEntries.clockOutAt))),
    db.insert(timeEntryAudit).values({
      timeEntryId: entryId,
      employeeId: entry.employeeId,
      operatorId,
      action: "clock_out",
      reason,
      before: snapshotOf(entry),
      after: snapshotOf(after),
    }),
  ]);
}

export type PunchInput = {
  entryId: number | null;
  employeeId: number;
  role: JobRole;
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks: PayBreak[];
  declaredTipsCents: number;
  note: string | null;
  reason: string;
};

/** Adds a missed punch or edits one. Editing clears approval: payroll re-checks it. */
export async function saveManagerPunch(input: PunchInput, operatorId: number): Promise<{ error?: string }> {
  const now = new Date();
  const problem = punchProblem(input.clockInAt, input.clockOutAt, input.breaks, now);
  if (problem) return { error: problem };

  const employee = await db.query.employees.findFirst({
    where: eq(employees.id, input.employeeId),
    with: { roles: true },
  });
  if (!employee) return { error: "That employee no longer exists." };
  const roleRate = employee.roles.find((r) => r.role === input.role)?.hourlyRateCents;

  const before = input.entryId === null ? undefined : await entryWithBreaks(input.entryId);
  if (input.entryId !== null && (!before || before.employeeId !== input.employeeId)) {
    return { error: "That punch no longer exists." };
  }
  // A changed role takes that role's current rate; otherwise the clock-in snapshot stands.
  const rate = before && before.role === input.role ? before.hourlyRateCents : roleRate;
  if (rate === undefined) return { error: `${employee.name} has no ${ROLE_LABEL[input.role]} rate. Add the role first.` };

  const values = {
    role: input.role,
    hourlyRateCents: rate,
    clockInAt: input.clockInAt,
    clockOutAt: input.clockOutAt,
    declaredTipsCents: input.declaredTipsCents,
    note: input.note,
    approvedAt: null,
    approvedBy: null,
    updatedAt: now,
  };
  const breakRows = (entryId: number) => input.breaks.map((b) => ({ timeEntryId: entryId, ...b }));
  const afterOf = (id: number): EntryRow => ({
    ...(before ?? {
      id,
      employeeId: input.employeeId,
      shiftId: null,
      source: "manager" as const,
      createdAt: now,
    }),
    ...values,
    breaks: input.breaks.map((b, i) => ({ id: i, timeEntryId: id, ...b })),
  });

  try {
    if (!before) {
      const published = await publishedShiftsOf(input.employeeId, new Date(input.clockInAt.getTime() - 14 * HOUR), new Date(input.clockInAt.getTime() + 24 * HOUR));
      const [created] = await db
        .insert(timeEntries)
        .values({
          ...values,
          employeeId: input.employeeId,
          shiftId: matchShift(input.clockInAt, published)?.id ?? null,
          source: "manager",
        })
        .returning({ id: timeEntries.id });
      const audit = db.insert(timeEntryAudit).values({
        timeEntryId: created.id,
        employeeId: input.employeeId,
        operatorId,
        action: "create",
        reason: input.reason,
        after: snapshotOf(afterOf(created.id)),
      });
      if (input.breaks.length > 0) await db.batch([db.insert(timeBreaks).values(breakRows(created.id)), audit]);
      else await audit;
      return {};
    }

    const audits = [
      ...(before.approvedAt
        ? [{ action: "unapprove" as const, reason: "Edited after approval" }]
        : []),
      { action: "edit" as const, reason: input.reason },
    ].map((a) =>
      db.insert(timeEntryAudit).values({
        timeEntryId: before.id,
        employeeId: before.employeeId,
        operatorId,
        ...a,
        before: snapshotOf(before),
        after: snapshotOf(afterOf(before.id)),
      }),
    );
    await db.batch([
      db.update(timeEntries).set(values).where(eq(timeEntries.id, before.id)),
      db.delete(timeBreaks).where(eq(timeBreaks.timeEntryId, before.id)),
      ...(input.breaks.length > 0 ? [db.insert(timeBreaks).values(breakRows(before.id))] : []),
      ...audits,
    ]);
    return {};
  } catch (error) {
    if (isUniqueViolation(error)) return { error: `${employee.name} already has an open punch. Clock that one out first.` };
    throw error;
  }
}

export async function deleteManagerPunch(entryId: number, operatorId: number, reason: string): Promise<void> {
  const entry = await entryWithBreaks(entryId);
  if (!entry) return;
  await db.batch([
    db.insert(timeEntryAudit).values({
      timeEntryId: entryId,
      employeeId: entry.employeeId,
      operatorId,
      action: "delete",
      reason,
      before: snapshotOf(entry),
    }),
    db.delete(timeEntries).where(eq(timeEntries.id, entryId)),
  ]);
}

/**
 * Approves the closed, unapproved punches of a week, for one employee or for
 * everyone. An employee with a punch still open is skipped: an open punch has
 * no hours to sign off on yet.
 */
export async function approveWeek(
  weekStart: LocalDate,
  employeeId: number | null,
  operatorId: number,
  cfg: StaffConfig,
): Promise<number> {
  const { from, to } = weekRange(weekStart, cfg.timezone);
  const inWeek = and(
    gte(timeEntries.clockInAt, from),
    lt(timeEntries.clockInAt, to),
    employeeId === null ? undefined : eq(timeEntries.employeeId, employeeId),
  );
  const rows = await db
    .select({ id: timeEntries.id, employeeId: timeEntries.employeeId, clockOutAt: timeEntries.clockOutAt, approvedAt: timeEntries.approvedAt })
    .from(timeEntries)
    .where(inWeek);
  const blocked = new Set(rows.filter((r) => r.clockOutAt === null).map((r) => r.employeeId));
  const toApprove = rows.filter((r) => r.approvedAt === null && !blocked.has(r.employeeId));
  if (toApprove.length === 0) return 0;
  const now = new Date();
  await db.batch([
    db
      .update(timeEntries)
      .set({ approvedAt: now, approvedBy: operatorId })
      .where(and(inArray(timeEntries.id, toApprove.map((r) => r.id)), isNull(timeEntries.approvedAt), isNotNull(timeEntries.clockOutAt))),
    db.insert(timeEntryAudit).values(
      toApprove.map((r) => ({ timeEntryId: r.id, employeeId: r.employeeId, operatorId, action: "approve" as const })),
    ),
  ]);
  return toApprove.length;
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

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
  roles: { role: JobRole; hourlyRateCents: number; isPrimary: boolean }[];
  availability: WeeklyAvailability | null;
  weekMinutes: number;
};

export type ScheduleWeek = {
  weekStart: LocalDate;
  dates: LocalDate[];
  employees: ScheduleEmployee[];
  shifts: ScheduleShift[];
  timeOff: { id: number; employeeId: number; startDate: LocalDate; endDate: LocalDate; status: "pending" | "approved"; reason: string | null }[];
  drafts: number;
  days: { date: LocalDate; minutes: number; costCents: number; forecastCents: number | null }[];
};

/** Non-canceled order subtotals per store-local date, for [from, to). */
async function salesByDate(from: Date, to: Date, tz: string): Promise<Map<LocalDate, number>> {
  const day = sql<string>`to_char(${orders.placedAt} at time zone ${tz}, 'YYYY-MM-DD')`;
  const rows = await db
    .select({ day, cents: sql<number>`sum(${orders.subtotalCents})::int` })
    .from(orders)
    .where(and(ne(orders.status, "canceled"), gte(orders.placedAt, from), lt(orders.placedAt, to)))
    .groupBy(sql`1`);
  return new Map(rows.map((r) => [r.day, r.cents]));
}

export async function getScheduleWeek(weekStart: LocalDate, cfg: StaffConfig): Promise<ScheduleWeek> {
  const tz = cfg.timezone;
  const { from, to, dates } = weekRange(weekStart, tz);
  const [people, shiftRows, offRows, sales] = await Promise.all([
    db.query.employees.findMany({
      where: eq(employees.isActive, true),
      columns: { id: true, name: true, availability: true },
      with: { roles: { columns: { role: true, hourlyRateCents: true, isPrimary: true } } },
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

  const byId = new Map(people.map((p) => [p.id, p]));
  const scheduled = shiftRows.filter((s) => s.employeeId === null || byId.has(s.employeeId));
  const timeOff = offRows.map((t) => ({
    id: t.id,
    employeeId: t.employeeId,
    startDate: t.startDate,
    endDate: t.endDate,
    status: t.status === "approved" ? ("approved" as const) : ("pending" as const),
    reason: t.reason,
  }));

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
        ? shiftConflicts(
            s,
            scheduled.filter((o) => o.employeeId === person.id),
            timeOff.filter((t) => t.employeeId === person.id),
            person.availability,
            cfg.rules,
            tz,
          )
        : [],
    };
  });

  return {
    weekStart,
    dates,
    employees: people.map((p) => ({
      ...p,
      weekMinutes: list.filter((s) => s.employeeId === p.id).reduce((n, s) => n + s.paidMinutes, 0),
    })),
    shifts: list,
    timeOff,
    drafts: list.filter((s) => !s.published).length,
    days: dates.map((date) => {
      const today = list.filter((s) => s.date === date);
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
  const prev = weekRange(addDays(weekStart, -7), tz);
  const cur = weekRange(weekStart, tz);
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
  const { from, to } = weekRange(weekStart, cfg.timezone);
  const published = await db
    .update(shifts)
    .set({ publishedAt: new Date() })
    .where(and(gte(shifts.startsAt, from), lt(shifts.startsAt, to), isNull(shifts.publishedAt)))
    .returning({ id: shifts.id });
  return published.length;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export type OverviewData = {
  onClock: { entryId: number; employeeName: string; role: JobRole; since: Date; paidMinutes: number; onBreak: boolean }[];
  late: { shiftId: number; employeeName: string; role: JobRole; startsAt: Date }[];
  today: { laborCents: number; salesCents: number; laborPercent: number | null };
  week: {
    scheduledMinutes: number;
    actualMinutes: number;
    otRisk: { employeeId: number; name: string; projectedMinutes: number }[];
  };
  attention: { flags: { flag: EntryFlag; count: number }[]; pendingTimeOff: number; unapprovedLastWeek: number };
};

/** How close to the weekly threshold counts as overtime risk. */
const OT_RISK_MARGIN_MINUTES = 120;

export async function getOverview(cfg: StaffConfig, now = new Date()): Promise<OverviewData> {
  const tz = cfg.timezone;
  const today = localDateOf(now, tz);
  const day = dayRange(today, tz);
  const weekStart = weekStartOf(today, cfg.rules.weekStartsOn);
  const week = weekRange(weekStart, tz);
  const lastWeek = weekRange(addDays(weekStart, -7), tz);

  const [open, todayEntries, weekShifts, sales, sheet, [pending], [unapproved]] = await Promise.all([
    db.query.timeEntries.findMany({
      where: isNull(timeEntries.clockOutAt),
      with: { breaks: true, employee: { columns: { name: true, isActive: true } } },
      orderBy: [asc(timeEntries.clockInAt)],
    }),
    db.query.timeEntries.findMany({
      where: and(gte(timeEntries.clockInAt, new Date(day.from.getTime() - 2 * HOUR)), lt(timeEntries.clockInAt, day.to)),
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

  const grace = cfg.rules.clockGraceMinutes * MINUTE;
  const late = weekShifts
    .filter(({ shift }) => localDateOf(shift.startsAt, tz) === today && shift.startsAt.getTime() + grace < now.getTime())
    .filter(
      ({ shift }) =>
        !todayEntries.some(
          (e) =>
            e.employeeId === shift.employeeId &&
            (e.shiftId === shift.id ||
              (e.clockInAt.getTime() >= shift.startsAt.getTime() - 2 * HOUR && e.clockInAt <= shift.endsAt)),
        ),
    )
    .map(({ shift, employeeName }) => ({ shiftId: shift.id, employeeName, role: shift.role, startsAt: shift.startsAt }));

  const laborCents = Math.round(
    todayEntries
      .filter((e) => localDateOf(e.clockInAt, tz) === today)
      .reduce((sum, e) => sum + (entryMinutes(toPayEntry(e), now).paidMinutes * e.hourlyRateCents) / 60, 0),
  );
  const salesCents = sales.get(today) ?? 0;

  const otRisk = sheet
    .map((row) => {
      const ahead = remainingShiftMinutes(
        weekShifts.filter(({ shift }) => shift.employeeId === row.employee.id).map(({ shift }) => shift),
        now,
      );
      return { employeeId: row.employee.id, name: row.employee.name, projectedMinutes: row.pay.totals.paidMinutes + ahead };
    })
    .filter((r) => r.projectedMinutes > cfg.rules.otWeeklyMinutes - OT_RISK_MARGIN_MINUTES)
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
    today: { laborCents, salesCents, laborPercent: salesCents > 0 ? (laborCents / salesCents) * 100 : null },
    week: {
      scheduledMinutes: weekShifts.reduce((n, { shift }) => n + shiftPaidMinutes(shift), 0),
      actualMinutes: sheet.reduce((n, row) => n + row.pay.totals.paidMinutes, 0),
      otRisk,
    },
    attention: {
      flags: ENTRY_FLAGS.filter((f) => f !== "edited" && flagCounts.has(f)).map((flag) => ({ flag, count: flagCounts.get(flag)! })),
      pendingTimeOff: pending?.n ?? 0,
      unapprovedLastWeek: unapproved?.n ?? 0,
    },
  };
}
