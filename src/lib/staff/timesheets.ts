import "server-only";
import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, employees, timeBreaks, timeEntries, timeEntryAudit } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { nextId } from "@/db/ids";
import {
  computeWeek,
  entryFlags,
  matchShift,
  punchProblem,
  ROLE_LABEL,
  snapshotOf,
  wasEdited,
  type EntryFlag,
  type JobRole,
  type PayBreak,
  type TimeAuditAction,
  type WeekPay,
} from "@/lib/timeclock";
import { weekBounds, type LocalDate } from "@/lib/zoned";
import type { StaffConfig } from "@/lib/staff/config";
import { entryWithBreaks, publishedShiftsNear, snapshotOfRow, toPayEntry } from "@/lib/staff/queries";

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
  audit: { id: number; action: TimeAuditAction; reason: string | null; at: Date; operatorName: string | null }[];
};

export type TimesheetRow = {
  employee: { id: number; name: string; isActive: boolean };
  entries: TimesheetEntry[];
  pay: WeekPay;
  /** Payroll pay: closed punches only. */
  closedPay: WeekPay;
  flagCount: number;
  status: TimesheetStatus;
};

export type TimesheetStatus = "empty" | "approved" | "open" | "needs_approval";

function statusOf(entries: TimesheetEntry[]): TimesheetStatus {
  if (entries.length === 0) return "empty";
  if (entries.every((e) => e.approvedAt !== null)) return "approved";
  return entries.some((e) => e.clockOutAt === null) ? "open" : "needs_approval";
}

export async function getTimesheetWeek(weekStart: LocalDate, cfg: StaffConfig, now = new Date()): Promise<TimesheetRow[]> {
  const tz = cfg.timezone;
  const { from, to } = weekBounds(weekStart, tz);
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
  const byEmployee = Map.groupBy(rows, (r) => r.employeeId);

  return people
    .map((employee) => {
      const mine = byEmployee.get(employee.id) ?? [];
      const pay = computeWeek(mine.map((row) => ({ ...toPayEntry(row), row })), cfg.rules, tz, now);
      const entries: TimesheetEntry[] = pay.entries.map(({ row: r, date, paidMinutes, breakMinutes }) => {
        const audit = r.audit
          .toSorted((a, b) => a.at.getTime() - b.at.getTime())
          .map((a) => ({ id: a.id, action: a.action, reason: a.reason, at: a.at, operatorName: a.operator?.name ?? null }));
        return {
          id: r.id,
          date,
          role: r.role,
          rateCents: r.hourlyRateCents,
          clockInAt: r.clockInAt,
          clockOutAt: r.clockOutAt,
          breaks: r.breaks.toSorted((a, b) => a.startedAt.getTime() - b.startedAt.getTime()),
          declaredTipsCents: r.declaredTipsCents,
          note: r.note,
          source: r.source,
          approvedAt: r.approvedAt,
          paidMinutes,
          breakMinutes,
          flags: entryFlags({ ...toPayEntry(r), edited: wasEdited(audit) }, r.shift, cfg.rules, now),
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
        status: statusOf(entries),
      };
    })
    .filter((row) => row.employee.isActive || row.entries.length > 0);
}

/** Closes a punch someone forgot, ending any open break at the same moment. */
export async function managerClockOut(entryId: number, operatorId: number, reason: string): Promise<void> {
  const entry = await entryWithBreaks(entryId);
  if (!entry || entry.clockOutAt !== null) return;
  const now = new Date();
  const after = snapshotOf({
    ...toPayEntry(entry),
    note: entry.note,
    clockOutAt: now,
    breaks: entry.breaks.map((b) => ({ startedAt: b.startedAt, endedAt: b.endedAt ?? now, paid: b.paid })),
  });
  const at = now.toISOString();
  // The audit row comes from the update's returning rows: if another tab
  // closed the punch first, nothing changed and nothing is audited.
  await db.batch([
    db.update(timeBreaks).set({ endedAt: now }).where(and(eq(timeBreaks.timeEntryId, entryId), isNull(timeBreaks.endedAt))),
    db.execute(sql`
      with closed as (
        update time_entries set clock_out_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
        where id = ${entryId} and clock_out_at is null
        returning id, employee_id
      )
      insert into time_entry_audit (time_entry_id, employee_id, operator_id, action, reason, before, after)
      select id, employee_id, ${operatorId}, 'clock_out', ${reason},
        ${JSON.stringify(snapshotOfRow(entry))}::jsonb, ${JSON.stringify(after)}::jsonb
      from closed`),
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

  const [employee, before] = await Promise.all([
    db.query.employees.findFirst({ where: eq(employees.id, input.employeeId), with: { roles: true } }),
    input.entryId === null ? undefined : entryWithBreaks(input.entryId),
  ]);
  if (!employee) return { error: "That employee no longer exists." };
  if (input.entryId !== null && (!before || before.employeeId !== input.employeeId)) {
    return { error: "That punch no longer exists." };
  }
  // A changed role takes that role's current rate; otherwise the clock-in snapshot stands.
  const rate =
    before && before.role === input.role
      ? before.hourlyRateCents
      : employee.roles.find((r) => r.role === input.role)?.hourlyRateCents;
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
  const after = snapshotOf({ ...input, rateCents: rate });

  try {
    if (!before) {
      const [published, id] = await Promise.all([
        publishedShiftsNear(input.employeeId, input.clockInAt),
        nextId("time_entries"),
      ]);
      await db.batch([
        db
          .insert(timeEntries)
          .overridingSystemValue()
          .values({
            ...values,
            id,
            employeeId: input.employeeId,
            shiftId: matchShift(input.clockInAt, published)?.id ?? null,
            source: "manager",
          }),
        ...(input.breaks.length > 0 ? [db.insert(timeBreaks).values(breakRows(id))] : []),
        db.insert(timeEntryAudit).values({
          timeEntryId: id,
          employeeId: input.employeeId,
          operatorId,
          action: "create",
          reason: input.reason,
          after,
        }),
      ]);
      return {};
    }

    const audits = [
      ...(before.approvedAt ? [{ action: "unapprove" as const, reason: "Edited after approval" }] : []),
      { action: "edit" as const, reason: input.reason },
    ].map((a) =>
      db.insert(timeEntryAudit).values({
        timeEntryId: before.id,
        employeeId: before.employeeId,
        operatorId,
        ...a,
        before: snapshotOfRow(before),
        after,
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
      before: snapshotOfRow(entry),
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
  const { from, to } = weekBounds(weekStart, cfg.timezone);
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
  const at = new Date().toISOString();
  // One audit row per punch the update actually approved, so a second tab
  // approving at the same time can't log the same approval twice.
  const { rows: approved } = await db.execute(sql`
    with approved as (
      update time_entries set approved_at = ${at}::timestamptz, approved_by = ${operatorId}
      where ${inArray(timeEntries.id, toApprove.map((r) => r.id))} and approved_at is null and clock_out_at is not null
      returning id, employee_id
    )
    insert into time_entry_audit (time_entry_id, employee_id, operator_id, action)
    select id, employee_id, ${operatorId}, 'approve' from approved
    returning id`);
  return approved.length;
}
