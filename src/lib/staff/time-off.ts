import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { db, timeOffRequests } from "@/db";
import type { LocalDate } from "@/lib/zoned";

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
