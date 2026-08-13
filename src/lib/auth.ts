import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, operators } from "@/db";

const SESSION_COOKIE = "minks_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 1 week

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSession(operatorId: number): Promise<void> {
  const token = await new SignJWT({ sub: String(operatorId) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function getSessionOperatorId(): Promise<number | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: ["HS256"],
    });
    return payload.sub ? Number(payload.sub) : null;
  } catch {
    return null;
  }
}

export async function getCurrentOperator() {
  const id = await getSessionOperatorId();
  if (id === null) return null;
  const [operator] = await db
    .select({ id: operators.id, email: operators.email, name: operators.name })
    .from(operators)
    .where(eq(operators.id, id));
  return operator ?? null;
}

/** Gate for admin pages/actions. Redirects to setup or login as appropriate. */
export async function requireOperator() {
  const operator = await getCurrentOperator();
  if (!operator) {
    const anyOperator = await db
      .select({ id: operators.id })
      .from(operators)
      .limit(1);
    redirect(anyOperator.length === 0 ? "/admin/setup" : "/admin/login");
  }
  return operator!;
}

export async function operatorExists(): Promise<boolean> {
  const rows = await db
    .select({ id: operators.id })
    .from(operators)
    .limit(1);
  return rows.length > 0;
}
