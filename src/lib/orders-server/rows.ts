/** Row-to-domain mapping shared by the order views and the report facts. */
import { inArray } from "drizzle-orm";
import { db, employees, orders } from "@/db";
import type { Totals } from "@/lib/orders";

/** Names for the given employee ids, for activity logs and reports. */
export async function staffNames(ids: Iterable<number | null>): Promise<Record<number, string>> {
  const wanted = [...new Set(ids)].filter((id) => id !== null);
  if (wanted.length === 0) return {};
  const rows = await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, wanted));
  return Object.fromEntries(rows.map((e) => [e.id, e.name]));
}

export function totalsOf(o: typeof orders.$inferSelect): Totals {
  return {
    subtotalCents: o.subtotalCents,
    discountCents: o.discountCents,
    taxCents: o.taxCents,
    deliveryFeeCents: o.deliveryFeeCents,
    tipCents: o.tipCents,
    totalCents: o.totalCents,
    paidCents: o.paidCents,
    refundedCents: o.refundedCents,
  };
}
