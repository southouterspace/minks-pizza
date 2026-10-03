"use server";

import type { z } from "zod";
import {
  closeShift as closeShiftSeam,
  mutateOrder,
  openShift as openShiftSeam,
  recordDrawerEvent,
  type Failure,
  type MutationResult,
  type ShiftResult,
} from "@/lib/orders-server";
import type { Actor, ShiftReport } from "@/lib/orders";
import { getStaff, lockTerminal as clearStaff, unlockStaff, type StaffContext } from "@/lib/staff";
import {
  closeShiftSchema,
  drawerEventSchema,
  mutateOrderSchema,
  openShiftSchema,
  pinSchema,
} from "@/lib/validation";

export type Locked = { ok: false; reason: "locked" };
type Invalid = { ok: false; reason: "rejected"; message: string };

function invalid(error: z.ZodError): Invalid {
  return { ok: false, reason: "rejected", message: error.issues[0]?.message ?? "Invalid input." };
}

/** parse → staff → seam: the shape of every action below. */
async function withStaff<S extends z.ZodType, R>(
  schema: S,
  input: unknown,
  seam: (data: z.output<S>, staff: StaffContext) => Promise<R>,
): Promise<R | Locked | Invalid> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const staff = await getStaff();
  if (!staff) return { ok: false, reason: "locked" };
  return seam(parsed.data, staff);
}

export async function switchEmployee(
  pin: unknown,
): Promise<{ ok: true; actor: Actor } | { ok: false; reason: "bad_pin" | "locked_out" | "signed_out" } | Invalid> {
  const parsed = pinSchema.safeParse(pin);
  if (!parsed.success) return invalid(parsed.error);
  return unlockStaff(parsed.data);
}

export async function lockTerminal(): Promise<void> {
  await clearStaff();
}

export async function mutateOrderAction(input: unknown): Promise<MutationResult | Locked | Invalid> {
  return withStaff(mutateOrderSchema, input, mutateOrder);
}

export async function openShift(input: unknown): Promise<ShiftResult | Locked | Invalid> {
  return withStaff(openShiftSchema, input, openShiftSeam);
}

export async function closeShift(
  input: unknown,
): Promise<{ ok: true; report: ShiftReport } | Failure | Locked | Invalid> {
  return withStaff(closeShiftSchema, input, closeShiftSeam);
}

export async function drawerEvent(input: unknown): Promise<{ ok: true } | Failure | Locked | Invalid> {
  return withStaff(drawerEventSchema, input, recordDrawerEvent);
}
