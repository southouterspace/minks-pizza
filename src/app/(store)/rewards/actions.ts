"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, loyaltyMembers } from "@/db";
import {
  getCurrentMemberId,
  requestLoginCode,
  signOutMember,
  verifyLoginCode,
  type CodeRequestResult,
} from "@/lib/member-auth";
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

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const birthdaySchema = z
  .object({ month: z.coerce.number().int().min(1).max(12), day: z.coerce.number().int().min(1).max(31) })
  .refine((b) => b.day <= DAYS_IN_MONTH[b.month - 1], "That date doesn't exist.");

/** Customers set their birthday once; changes go through the store. */
export async function saveBirthday(formData: FormData): Promise<void> {
  const memberId = await getCurrentMemberId();
  if (memberId === null) return;
  const { month, day } = birthdaySchema.parse({
    month: formData.get("month"),
    day: formData.get("day"),
  });
  await db
    .update(loyaltyMembers)
    .set({ birthMonth: month, birthDay: day, birthdaySetAt: new Date() })
    .where(and(eq(loyaltyMembers.id, memberId), isNull(loyaltyMembers.birthMonth)));
  revalidatePath("/rewards");
}
