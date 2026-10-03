import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { db, employees, shifts, timeOffRequests } from "@/db";
import { shiftTouchesTimeOff, type JobRole } from "@/lib/timeclock";
import { addDays, localDateOf, zonedInstant, type LocalDate } from "@/lib/zoned";
import type { StaffConfig } from "@/lib/staff/config";

export type TimeOffBy = { kind: "employee" } | { kind: "manager"; operatorId: number };

/** The partial unique index `time_off_one_live`, as an ON CONFLICT target. */
const LIVE_REQUEST = {
  target: [timeOffRequests.employeeId, timeOffRequests.startDate, timeOffRequests.endDate],
  where: sql`${timeOffRequests.status} <> 'denied'`,
};

/**
 * Files a time-off request. A manager adding it approves it on the spot, and
 * approves a pending request for the same dates. Re-sending the same dates
 * lands on the existing request.
 */
export async function requestTimeOff(
  input: { employeeId: number; startDate: LocalDate; endDate: LocalDate; reason: string | null },
  by: TimeOffBy,
): Promise<void> {
  if (by.kind === "employee") {
    await db
      .insert(timeOffRequests)
      .values({ ...input, status: "pending", source: "kiosk" })
      .onConflictDoNothing(LIVE_REQUEST);
    return;
  }
  const decided = { status: "approved" as const, decidedBy: by.operatorId, decidedAt: new Date() };
  await db
    .insert(timeOffRequests)
    .values({ ...input, ...decided, source: "manager" })
    .onConflictDoUpdate({
      target: LIVE_REQUEST.target,
      targetWhere: LIVE_REQUEST.where,
      set: decided,
      setWhere: eq(timeOffRequests.status, "pending"),
    });
}

export async function decideTimeOff(id: number, status: "approved" | "denied", operatorId: number): Promise<void> {
  await db
    .update(timeOffRequests)
    .set({ status, decidedBy: operatorId, decidedAt: new Date() })
    .where(and(eq(timeOffRequests.id, id), eq(timeOffRequests.status, "pending")));
}

export type TimeOffRequestRow = {
  id: number;
  employeeId: number;
  name: string;
  startDate: LocalDate;
  endDate: LocalDate;
  reason: string | null;
  status: "pending" | "approved" | "denied";
  source: "kiosk" | "manager";
  createdAt: Date;
  decidedAt: Date | null;
};

export type TimeOffBoard = {
  today: LocalDate;
  /** Each with the shifts it lands on, drafts included. */
  pending: (TimeOffRequestRow & {
    conflicts: { id: number; role: JobRole; startsAt: Date; endsAt: Date; published: boolean }[];
  })[];
  upcoming: TimeOffRequestRow[];
  /** Decided in the last 30 days, newest first. */
  decided: TimeOffRequestRow[];
  employees: { id: number; name: string }[];
};

export async function getTimeOffBoard(cfg: StaffConfig, now = new Date()): Promise<TimeOffBoard> {
  const tz = cfg.timezone;
  const today = localDateOf(now, tz);
  const request = {
    id: timeOffRequests.id,
    employeeId: timeOffRequests.employeeId,
    name: employees.name,
    startDate: timeOffRequests.startDate,
    endDate: timeOffRequests.endDate,
    reason: timeOffRequests.reason,
    status: timeOffRequests.status,
    source: timeOffRequests.source,
    createdAt: timeOffRequests.createdAt,
    decidedAt: timeOffRequests.decidedAt,
  };
  const requests = () => db.select(request).from(timeOffRequests).innerJoin(employees, eq(employees.id, timeOffRequests.employeeId));
  const [pending, upcoming, decided, people] = await Promise.all([
    requests().where(eq(timeOffRequests.status, "pending")).orderBy(asc(timeOffRequests.startDate)),
    requests()
      .where(and(eq(timeOffRequests.status, "approved"), gte(timeOffRequests.endDate, today)))
      .orderBy(asc(timeOffRequests.startDate)),
    requests()
      .where(
        and(
          ne(timeOffRequests.status, "pending"),
          isNotNull(timeOffRequests.decidedAt),
          gte(timeOffRequests.decidedAt, zonedInstant(addDays(today, -30), "00:00", tz)),
        ),
      )
      .orderBy(desc(timeOffRequests.decidedAt))
      .limit(20),
    db.select({ id: employees.id, name: employees.name }).from(employees).where(eq(employees.isActive, true)).orderBy(asc(employees.name)),
  ]);

  // One query for every pending request's people and days; the overlap rule
  // then decides which shift lands on which request.
  const span = pending.length === 0
    ? null
    : {
        from: zonedInstant(pending.map((r) => r.startDate).reduce((a, b) => (a < b ? a : b)), "00:00", tz),
        to: zonedInstant(addDays(pending.map((r) => r.endDate).reduce((a, b) => (a > b ? a : b)), 1), "00:00", tz),
      };
  const candidates = span
    ? await db
        .select({ id: shifts.id, employeeId: shifts.employeeId, role: shifts.role, startsAt: shifts.startsAt, endsAt: shifts.endsAt, publishedAt: shifts.publishedAt })
        .from(shifts)
        .where(
          and(
            inArray(shifts.employeeId, [...new Set(pending.map((r) => r.employeeId))]),
            lt(shifts.startsAt, span.to),
            gte(shifts.endsAt, span.from),
          ),
        )
        .orderBy(asc(shifts.startsAt))
    : [];

  return {
    today,
    pending: pending.map((r) => ({
      ...r,
      conflicts: candidates
        .filter((s) => s.employeeId === r.employeeId && shiftTouchesTimeOff(s, r, tz))
        .map((s) => ({ id: s.id, role: s.role, startsAt: s.startsAt, endsAt: s.endsAt, published: s.publishedAt !== null })),
    })),
    upcoming,
    decided,
    employees: people,
  };
}
