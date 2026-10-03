/** Row-to-domain mapping shared by the order views and the report facts. */
import { inArray } from "drizzle-orm";
import { db, employees, orders } from "@/db";
import type { Fulfillment, Totals } from "@/lib/orders";

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

/**
 * The address and table columns are nullable because only one order type
 * uses each; every writer (fulfillmentColumns, the old storefront checkout)
 * fills the ones its type needs. A row without them is corrupt, not a
 * delivery to an empty street.
 */
export function fulfillmentOf(o: typeof orders.$inferSelect): Fulfillment {
  switch (o.orderType) {
    case "pickup":
      return { kind: "pickup" };
    case "delivery":
      if (o.addressLine1 === null || o.zip === null) throw new Error(`Order ${o.id} is a delivery with no address.`);
      return { kind: "delivery", address: { line1: o.addressLine1, line2: o.addressLine2, city: o.city, zip: o.zip } };
    case "dine_in":
      if (o.tableLabel === null) throw new Error(`Order ${o.id} is dine-in with no table.`);
      return { kind: "dine_in", table: o.tableLabel };
  }
}
