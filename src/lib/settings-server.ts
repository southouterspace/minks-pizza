import { eq } from "drizzle-orm";
import { db, storeSettings } from "@/db";
import type { PricingPolicy } from "@/lib/pricing";
import { DEFAULT_TIMEZONE } from "@/lib/store-time";

export class StoreNotConfiguredError extends Error {}

export async function getSettings() {
  const [settings] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
  if (!settings) throw new StoreNotConfiguredError("Store is not configured yet.");
  return settings;
}

export type Settings = Awaited<ReturnType<typeof getSettings>>;

/** Name and timezone for admin pages, which render before the store is configured. */
export async function getStoreBasics(): Promise<{ name: string; timezone: string }> {
  const [row] = await db
    .select({ name: storeSettings.name, timezone: storeSettings.timezone })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  return row ?? { name: "My Pizzeria", timezone: DEFAULT_TIMEZONE };
}

export function policyOf(s: Settings): PricingPolicy {
  return { halfToppingRule: s.halfToppingRule, extraToppingBps: s.extraToppingBps };
}
