import { createHmac } from "node:crypto";

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
