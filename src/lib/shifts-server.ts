/** Shifts and the cash drawer. Only one shift is open at a time. */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, drawerEvents, shifts } from "@/db";
import { DRAWER_ROLE, rejected, type Approval, type DrawerEventKind, type Failure, type ShiftResult } from "@/lib/orders";
import { authorize } from "@/lib/pin";
import type { ShiftReport } from "@/lib/reports";
import { getShiftReport } from "@/lib/reports-server";
import type { StaffContext } from "@/lib/staff";

export type Shift = typeof shifts.$inferSelect;

export async function getOpenShift(): Promise<Shift | null> {
  const [shift] = await db.select().from(shifts).where(isNull(shifts.closedAt));
  return shift ?? null;
}

export async function openShift(
  input: { shiftId: string; startingBankCents: number },
  staff: StaffContext,
): Promise<ShiftResult> {
  await db
    .insert(shifts)
    .values({ id: input.shiftId, openedBy: staff.actor.employeeId, startingBankCents: input.startingBankCents })
    .onConflictDoNothing();
  const open = await getOpenShift();
  return open?.id === input.shiftId ? { ok: true, shiftId: open.id } : rejected("Another shift is already open.");
}

export async function closeShift(
  input: {
    shiftId: string;
    countedCashCents: number;
    cardBatchCents: number;
    declaredCashTipsCents: number;
    notes: string | null;
    approval?: Approval;
  },
  staff: StaffContext,
): Promise<{ ok: true; report: ShiftReport } | Failure> {
  const auth = await authorize("manager", staff, input.approval);
  if (!auth.ok) return auth;
  await db
    .update(shifts)
    .set({
      closedAt: sql`now()`,
      closedBy: auth.approvedBy,
      countedCashCents: input.countedCashCents,
      cardBatchCents: input.cardBatchCents,
      declaredCashTipsCents: input.declaredCashTipsCents,
      notes: input.notes,
    })
    .where(and(eq(shifts.id, input.shiftId), isNull(shifts.closedAt)));
  const report = await getShiftReport(input.shiftId);
  return report ? { ok: true, report } : { ok: false, reason: "not_found" };
}

export async function recordDrawerEvent(
  input: { id: string; kind: DrawerEventKind; cents: number; reason: string | null; approval?: Approval },
  staff: StaffContext,
): Promise<{ ok: true } | Failure> {
  const auth = await authorize(DRAWER_ROLE[input.kind], staff, input.approval);
  if (!auth.ok) return auth;
  const shift = await getOpenShift();
  if (!shift) return { ok: false, reason: "no_open_shift" };
  await db
    .insert(drawerEvents)
    .values({
      id: input.id,
      shiftId: shift.id,
      kind: input.kind,
      cents: input.kind === "no_sale" ? 0 : input.cents,
      reason: input.reason,
      employeeId: staff.actor.employeeId,
      approvedBy: auth.approvedBy,
    })
    .onConflictDoNothing({ target: drawerEvents.id });
  return { ok: true };
}
