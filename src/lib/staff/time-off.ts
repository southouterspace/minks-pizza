import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, timeOffRequests } from "@/db";
import type { LocalDate } from "@/lib/zoned";

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
