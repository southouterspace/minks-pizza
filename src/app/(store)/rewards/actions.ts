"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, loyaltyLoginCodes, loyaltyMembers, orders } from "@/db";
import {
  getCurrentMemberId,
  requestLoginCode,
  signOutMember,
  verifyLoginCode,
  type CodeRequestResult,
} from "@/lib/member-auth";
import { birthdaySchema } from "@/lib/loyalty";
import { getLoyaltySettings } from "@/lib/loyalty-server";

export async function sendCode(phone: string): Promise<CodeRequestResult> {
  if (!(await getLoyaltySettings()).enabled) {
    return { ok: false, error: "Rewards aren't available right now." };
  }
  return requestLoginCode(z.string().max(30).parse(phone));
}

const verifySchema = z.object({
  phone: z.string().max(30),
  code: z.string().trim().max(10),
  name: z.string().trim().max(120).optional(),
  referralCode: z.string().trim().max(20).optional(),
});

export async function verifyCode(input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = verifySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter the 6-digit code we texted you." };
  const { phone, code, ...details } = parsed.data;
  const result = await verifyLoginCode(phone, code, details);
  if (!result.ok) return result;
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Who placed an order, when the program is on and the order can still earn. */
async function orderCustomer(orderId: string): Promise<{ phone: string; name: string } | null> {
  if (!z.uuid().safeParse(orderId).success || !(await getLoyaltySettings()).enabled) return null;
  const [order] = await db
    .select({ phone: orders.customerPhone, name: orders.customerName, status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId));
  return order && order.status !== "canceled" ? order : null;
}

/**
 * Texts a code to the phone an order was placed with. The order page holds
 * only the order id, so the full number never reaches the browser.
 */
export async function sendOrderCode(
  orderId: string,
): Promise<{ ok: true; devCode?: string } | { ok: false; error: string }> {
  const customer = await orderCustomer(orderId);
  if (!customer) return { ok: false, error: "Rewards aren't available for this order." };
  const result = await requestLoginCode(customer.phone);
  return result.ok ? { ok: true, devCode: result.devCode } : result;
}

const verifyOrderSchema = z.object({ orderId: z.string(), code: z.string().trim().max(10) });

/** Joins (or signs in) with the order's phone; signing in links the order. */
export async function verifyOrderCode(input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = verifyOrderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter the 6-digit code we texted you." };
  const customer = await orderCustomer(parsed.data.orderId);
  if (!customer) return { ok: false, error: "Rewards aren't available for this order." };
  const result = await verifyLoginCode(customer.phone, parsed.data.code, { name: customer.name });
  if (!result.ok) return result;
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function signOut(): Promise<void> {
  await signOutMember();
  revalidatePath("/", "layout");
}

/**
 * Erases the member: the ledger goes with them (cascade), orders keep their
 * rows with the member link nulled, and friends they referred stay members.
 */
export async function deleteMyAccount(): Promise<void> {
  const memberId = await getCurrentMemberId();
  if (memberId === null) return;
  await db.batch([
    db.delete(loyaltyLoginCodes).where(
      eq(loyaltyLoginCodes.phone, sql`(select phone from loyalty_members where id = ${memberId})`),
    ),
    db.delete(loyaltyMembers).where(eq(loyaltyMembers.id, memberId)),
  ]);
  await signOutMember();
  revalidatePath("/", "layout");
}

/** On error, what was picked, so the form can show it again after React resets it. */
export type BirthdayFormState = { error?: string; month?: string; day?: string };

/** Customers set their birthday once; changes go through the store. */
export async function saveBirthday(_prev: BirthdayFormState, formData: FormData): Promise<BirthdayFormState> {
  const memberId = await getCurrentMemberId();
  if (memberId === null) return { error: "Sign in to save your birthday." };
  const picked = { month: String(formData.get("month") ?? ""), day: String(formData.get("day") ?? "") };
  const parsed = birthdaySchema.safeParse(picked);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Pick a month and a day.", ...picked };
  await db
    .update(loyaltyMembers)
    .set({ birthMonth: parsed.data.month, birthDay: parsed.data.day, birthdaySetAt: new Date() })
    .where(and(eq(loyaltyMembers.id, memberId), isNull(loyaltyMembers.birthMonth)));
  revalidatePath("/rewards");
  return {};
}
