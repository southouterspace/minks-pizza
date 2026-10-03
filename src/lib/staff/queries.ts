import "server-only";
import { and, asc, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { db, shifts, timeBreaks, timeEntries, timeOffRequests } from "@/db";
import {
  shiftLookupWindow,
  snapshotOf,
  type AuditSnapshot,
  type KioskShift,
  type LiveTimeOffStatus,
  type PayEntry,
} from "@/lib/timeclock";

/** A punch with its breaks, as the queries below load it. */
export type EntryRow = typeof timeEntries.$inferSelect & { breaks: (typeof timeBreaks.$inferSelect)[] };

export function toPayEntry(e: EntryRow): PayEntry {
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

export function snapshotOfRow(e: EntryRow): AuditSnapshot {
  return snapshotOf({ ...toPayEntry(e), note: e.note });
}

export function toKioskShift(s: typeof shifts.$inferSelect): KioskShift {
  return {
    id: s.id,
    role: s.role,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    unpaidBreakMinutes: s.unpaidBreakMinutes,
  };
}

/** The roles columns every employee query loads. */
export const ROLE_COLUMNS = { role: true, hourlyRateCents: true, isPrimary: true } as const;

export type TimeOffView = {
  id: number;
  employeeId: number;
  startDate: string;
  endDate: string;
  status: LiveTimeOffStatus;
  reason: string | null;
};

/** For rows read with `status <> 'denied'`. */
export function toTimeOffView(t: typeof timeOffRequests.$inferSelect): TimeOffView {
  return {
    id: t.id,
    employeeId: t.employeeId,
    startDate: t.startDate,
    endDate: t.endDate,
    status: t.status === "approved" ? "approved" : "pending",
    reason: t.reason,
  };
}

export function openEntryOf(employeeId: number) {
  return db.query.timeEntries.findFirst({
    where: and(eq(timeEntries.employeeId, employeeId), isNull(timeEntries.clockOutAt)),
    with: { breaks: true },
  });
}

export function entryWithBreaks(id: number) {
  return db.query.timeEntries.findFirst({ where: eq(timeEntries.id, id), with: { breaks: true } });
}

export function publishedShiftsOf(employeeId: number, from: Date, to: Date) {
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

/** The published shifts a punch at `at` can belong to or be blocked by. */
export function publishedShiftsNear(employeeId: number, at: Date) {
  const { from, to } = shiftLookupWindow(at);
  return publishedShiftsOf(employeeId, from, to);
}
