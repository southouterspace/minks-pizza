/**
 * Staff at the POS terminal. The device is signed in by an operator session
 * (like /kitchen); staff then switch with a 4-digit PIN, which sets a short
 * second cookie. Roles are read from the database on every action, so a
 * demotion takes effect on the next tap.
 */
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { and, eq } from "drizzle-orm";
import { db, employees, storeSettings } from "@/db";
import { getSessionOperatorId } from "@/lib/auth";
import type { Actor } from "@/lib/orders";
import { checkPin, type PinCheck } from "@/lib/pin";

const STAFF_COOKIE = "minks_staff";

export type StaffContext = { actor: Actor; operatorId: number };

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(secret);
}

async function actorById(employeeId: number): Promise<Actor | null> {
  const [employee] = await db
    .select({ employeeId: employees.id, name: employees.name, role: employees.role })
    .from(employees)
    .where(and(eq(employees.id, employeeId), eq(employees.isActive, true)));
  return employee ?? null;
}

/** Requires the operator session; on a good PIN, sets the staff cookie. */
export async function unlockStaff(
  pin: string,
): Promise<PinCheck | { ok: false; reason: "signed_out" }> {
  const operatorId = await getSessionOperatorId();
  if (operatorId === null) return { ok: false, reason: "signed_out" };
  const check = await checkPin(pin, operatorId);
  if (!check.ok) return check;
  await setStaffCookie(check.actor.employeeId, operatorId);
  return check;
}

async function setStaffCookie(employeeId: number, operatorId: number): Promise<void> {
  const [settings] = await db
    .select({ lockSeconds: storeSettings.posLockSeconds })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  const ttl = settings?.lockSeconds ?? 120;
  const token = await new SignJWT({ sub: String(employeeId), op: operatorId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(secretKey());
  (await cookies()).set(STAFF_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ttl,
  });
}

/**
 * Slides the lock window forward while someone is using the terminal, so the
 * cookie expires after idle time rather than mid-order.
 */
export async function renewStaff(): Promise<StaffContext | null> {
  const staff = await getStaff();
  if (staff) await setStaffCookie(staff.actor.employeeId, staff.operatorId);
  return staff;
}

export async function lockTerminal(): Promise<void> {
  (await cookies()).delete(STAFF_COOKIE);
}

/**
 * The employee at the terminal, or null when the terminal is locked. A staff
 * cookie minted under a different operator session does not count.
 */
export async function getStaff(): Promise<StaffContext | null> {
  const operatorId = await getSessionOperatorId();
  if (operatorId === null) return null;
  const token = (await cookies()).get(STAFF_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    if (payload.op !== operatorId || !payload.sub) return null;
    const actor = await actorById(Number(payload.sub));
    return actor ? { actor, operatorId } : null;
  } catch {
    return null;
  }
}
