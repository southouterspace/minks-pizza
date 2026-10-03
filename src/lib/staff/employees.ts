import "server-only";
import { createHmac, randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, employees } from "@/db";

export function pinDigest(pin: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return createHmac("sha256", secret).update(`pin:${pin}`).digest("hex");
}

/** A random 4-digit PIN nobody else has. */
export async function generatePin(): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pin = String(randomInt(0, 10_000)).padStart(4, "0");
    const [taken] = await db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.pinDigest, pinDigest(pin)));
    if (!taken) return pin;
  }
  throw new Error("Couldn't find a free PIN");
}
