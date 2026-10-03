import "server-only";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { cache } from "react";
import { SignJWT, jwtVerify } from "jose";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db, loyaltyLoginCodes } from "@/db";
import { normalizePhone } from "@/lib/loyalty";
import {
  claimRecentOrders,
  enrollVerifiedMember,
  getLoyaltySettings,
  getMember,
  memberByReferralCode,
  refreshMember,
} from "@/lib/loyalty-server";
import { getSettings } from "@/lib/orders";
import { sendLoginCode } from "@/lib/sms";

const MEMBER_COOKIE = "minks_member";
const MEMBER_TTL_SECONDS = 60 * 60 * 24 * 90;
const CODE_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_CODES_PER_WINDOW = 3;
const MAX_ATTEMPTS = 5;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

function hashCode(code: string): Buffer {
  return createHmac("sha256", secret()).update(code).digest();
}

export type CodeRequestResult =
  | { ok: true; phone: string; devCode?: string }
  | { ok: false; error: string };

export async function requestLoginCode(rawPhone: string): Promise<CodeRequestResult> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ok: false, error: "Enter a 10-digit US phone number." };

  const [{ recent }] = await db
    .select({ recent: count() })
    .from(loyaltyLoginCodes)
    .where(
      and(
        eq(loyaltyLoginCodes.phone, phone),
        gt(loyaltyLoginCodes.createdAt, new Date(Date.now() - RATE_WINDOW_MS)),
      ),
    );
  if (recent >= MAX_CODES_PER_WINDOW) {
    return { ok: false, error: "Too many codes requested. Try again in 15 minutes." };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.insert(loyaltyLoginCodes).values({
    phone,
    codeHash: hashCode(code).toString("hex"),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  const sent = await sendLoginCode(phone, code, (await getSettings()).name);
  return sent.ok ? { ok: true, phone, devCode: sent.devCode } : sent;
}

export type VerifyResult = { ok: true; memberId: number } | { ok: false; error: string };

export async function verifyLoginCode(
  rawPhone: string,
  code: string,
  details: { name?: string; referralCode?: string } = {},
): Promise<VerifyResult> {
  const phone = normalizePhone(rawPhone);
  if (!phone || !/^\d{6}$/.test(code)) return { ok: false, error: "Enter the 6-digit code we texted you." };

  const [pending] = await db
    .select()
    .from(loyaltyLoginCodes)
    .where(
      and(
        eq(loyaltyLoginCodes.phone, phone),
        isNull(loyaltyLoginCodes.consumedAt),
        gt(loyaltyLoginCodes.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(loyaltyLoginCodes.createdAt))
    .limit(1);
  if (!pending) return { ok: false, error: "That code has expired. Send a new one." };
  if (pending.attempts >= MAX_ATTEMPTS) {
    return { ok: false, error: "Too many wrong tries. Send a new code." };
  }

  if (!timingSafeEqual(hashCode(code), Buffer.from(pending.codeHash, "hex"))) {
    await db
      .update(loyaltyLoginCodes)
      .set({ attempts: sql`${loyaltyLoginCodes.attempts} + 1` })
      .where(eq(loyaltyLoginCodes.id, pending.id));
    return { ok: false, error: "That code isn't right. Check it and try again." };
  }

  // Enrolling, claiming and refreshing are idempotent, so they run before the
  // code is spent: if one fails, the customer can try the same code again.
  const referrer = details.referralCode ? await memberByReferralCode(details.referralCode) : null;
  const member = await enrollVerifiedMember(phone, {
    name: details.name ?? null,
    referredById: referrer?.id ?? null,
  });
  await claimRecentOrders(member);
  await refreshMember(member.id);

  const [consumed] = await db
    .update(loyaltyLoginCodes)
    .set({ consumedAt: new Date() })
    .where(and(eq(loyaltyLoginCodes.id, pending.id), isNull(loyaltyLoginCodes.consumedAt)))
    .returning({ id: loyaltyLoginCodes.id });
  if (!consumed) return { ok: false, error: "That code was already used. Send a new one." };
  await setMemberSession(member.id);
  return { ok: true, memberId: member.id };
}

async function setMemberSession(memberId: number): Promise<void> {
  const token = await new SignJWT({ sub: String(memberId) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MEMBER_TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(secret()));
  (await cookies()).set(MEMBER_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MEMBER_TTL_SECONDS,
  });
}

export const getCurrentMemberId = cache(async (): Promise<number | null> => {
  const token = (await cookies()).get(MEMBER_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret()), {
      algorithms: ["HS256"],
    });
    return payload.sub ? Number(payload.sub) : null;
  } catch {
    return null;
  }
});

/** The signed-in member, or null when signed out or the program is off. */
export const getCurrentMember = cache(async () => {
  const id = await getCurrentMemberId();
  if (id === null || !(await getLoyaltySettings()).enabled) return null;
  return getMember(id);
});

/**
 * The signed-in member after any expiry or birthday grant now due. Pages and
 * the store header share one refresh per request, so they show one balance.
 */
export const getRefreshedCurrentMember = cache(async () => {
  const member = await getCurrentMember();
  return member && refreshMember(member.id);
});

export async function signOutMember(): Promise<void> {
  (await cookies()).delete(MEMBER_COOKIE);
}
