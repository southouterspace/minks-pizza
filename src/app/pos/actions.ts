"use server";

import { z } from "zod";
import { mutateOrder } from "@/lib/orders-server/mutate";
import { getOrderView } from "@/lib/orders-server/views";
import { getShiftReport } from "@/lib/reports-server";
import { closeShift as closeShiftSeam, openShift as openShiftSeam, recordDrawerEvent } from "@/lib/shifts-server";
import {
  rejected,
  type Actor,
  type Failure,
  type MutationResult,
  type OrderView,
  type Rejected,
  type ShiftResult,
} from "@/lib/orders";
import type { ShiftReport } from "@/lib/reports";
import { getStaff, lockTerminal as clearStaff, renewStaff, unlockStaff, type StaffContext } from "@/lib/staff";
import {
  closeShiftSchema,
  drawerEventSchema,
  mutateOrderSchema,
  openShiftSchema,
  pinSchema,
} from "@/lib/validation";

export type Locked = { ok: false; reason: "locked" };
function invalid(error: z.ZodError): Rejected {
  return rejected(error.issues[0]?.message ?? "Invalid input.");
}

/** parse → staff → seam: the shape of every action below. */
async function withStaff<S extends z.ZodType, R>(
  schema: S,
  input: unknown,
  seam: (data: z.output<S>, staff: StaffContext) => Promise<R>,
): Promise<R | Locked | Rejected> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const staff = await getStaff();
  if (!staff) return { ok: false, reason: "locked" };
  return seam(parsed.data, staff);
}

export async function switchEmployee(
  pin: unknown,
): Promise<{ ok: true; actor: Actor } | { ok: false; reason: "bad_pin" | "locked_out" | "signed_out" } | Rejected> {
  const parsed = pinSchema.safeParse(pin);
  if (!parsed.success) return invalid(parsed.error);
  return unlockStaff(parsed.data);
}

export async function lockTerminal(): Promise<void> {
  await clearStaff();
}

export async function keepUnlocked(): Promise<{ ok: true; actor: Actor } | Locked> {
  const staff = await renewStaff();
  return staff ? { ok: true, actor: staff.actor } : { ok: false, reason: "locked" };
}

/** One order, any status: deep links, reprints and orders already off the board. */
export async function readOrder(orderId: unknown): Promise<{ ok: true; order: OrderView | null } | Locked | Rejected> {
  return withStaff(z.uuid(), orderId, async (id) => ({ ok: true as const, order: await getOrderView(id) }));
}

/** The running shift report, before anyone counts the drawer. */
export async function previewShift(shiftId: unknown): Promise<{ ok: true; report: ShiftReport | null } | Locked | Rejected> {
  return withStaff(z.uuid(), shiftId, async (id) => ({ ok: true as const, report: await getShiftReport(id) }));
}

export async function mutateOrderAction(input: unknown): Promise<MutationResult | Locked | Rejected> {
  return withStaff(mutateOrderSchema, input, mutateOrder);
}

export async function openShift(input: unknown): Promise<ShiftResult | Locked | Rejected> {
  return withStaff(openShiftSchema, input, openShiftSeam);
}

export async function closeShift(
  input: unknown,
): Promise<{ ok: true; report: ShiftReport } | Failure | Locked | Rejected> {
  return withStaff(closeShiftSchema, input, closeShiftSeam);
}

export async function drawerEvent(input: unknown): Promise<{ ok: true } | Failure | Locked | Rejected> {
  return withStaff(drawerEventSchema, input, recordDrawerEvent);
}
