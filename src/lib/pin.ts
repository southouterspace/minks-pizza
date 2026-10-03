import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, employees, pinAttempts } from "@/db";
import type { Actor } from "@/lib/orders";

const MAX_FAILURES = 5;
const FAILURE_WINDOW = "5 minutes";

export type PinCheck =
  | { ok: true; actor: Actor }
  | { ok: false; reason: "bad_pin" | "locked_out" };

/**
 * Keyed digest of a staff PIN. Keyed with SESSION_SECRET so a leaked
 * employees table can't be reversed by hashing all 10,000 PINs; rotating the
 * secret means re-setting every PIN.
 */
export function pinDigest(pin: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return createHmac("sha256", secret).update(`pin:${pin}`).digest("hex");
}

async function lockedOut(operatorId: number): Promise<boolean> {
  const [row] = await db
    .select({ one: sql`1` })
    .from(pinAttempts)
    .where(
      and(
        eq(pinAttempts.operatorId, operatorId),
        sql`${pinAttempts.failures} >= ${MAX_FAILURES}`,
        sql`${pinAttempts.windowStart} > now() - ${FAILURE_WINDOW}::interval`,
      ),
    );
  return row !== undefined;
}

function recordFailure(operatorId: number) {
  const expired = sql`${pinAttempts.windowStart} <= now() - ${FAILURE_WINDOW}::interval`;
  return db
    .insert(pinAttempts)
    .values({ operatorId, failures: 1 })
    .onConflictDoUpdate({
      target: pinAttempts.operatorId,
      set: {
        failures: sql`case when ${expired} then 1 else ${pinAttempts.failures} + 1 end`,
        windowStart: sql`case when ${expired} then now() else ${pinAttempts.windowStart} end`,
      },
    });
}

/**
 * Looks a PIN up by its digest among active staff. Failures count against
 * the signed-in device: five misses in five minutes lock it for the rest of
 * the window, because a 4-digit space is small.
 */
export async function checkPin(pin: string, operatorId: number): Promise<PinCheck> {
  if (await lockedOut(operatorId)) return { ok: false, reason: "locked_out" };
  const [employee] = await db
    .select({ employeeId: employees.id, name: employees.name, role: employees.role })
    .from(employees)
    .where(and(eq(employees.pinDigest, pinDigest(pin)), eq(employees.isActive, true)));
  if (!employee) {
    await recordFailure(operatorId);
    return { ok: false, reason: "bad_pin" };
  }
  await db.delete(pinAttempts).where(eq(pinAttempts.operatorId, operatorId));
  return { ok: true, actor: employee };
}
