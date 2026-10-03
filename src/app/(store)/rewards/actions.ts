"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, loyaltyLoginCodes, loyaltyMembers } from "@/db";
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
