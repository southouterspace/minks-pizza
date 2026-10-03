import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { categories, db, menuItems, orderItems, orders } from "@/db";
import { externalOrderRows, type ExternalOrder } from "@/lib/marketplace";

/**
 * Inserts a marketplace order and its items in one transaction. Marketplaces
 * redeliver orders, so a second copy returns the first one's id.
 */
export async function ingestExternalOrder(
  order: ExternalOrder,
): Promise<{ orderId: string; duplicate: boolean }> {
  const existing = async () => {
    const [row] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.source, order.source), eq(orders.sourceOrderId, order.sourceOrderId)));
    return row;
  };
  const seen = await existing();
  if (seen) return { orderId: seen.id, duplicate: true };

  const itemIds = order.lines.flatMap((l) => (l.merchantItemId === null ? [] : [l.merchantItemId]));
  const stations = itemIds.length
    ? await db
        .select({ id: menuItems.id, station: categories.station })
        .from(menuItems)
        .innerJoin(categories, eq(categories.id, menuItems.categoryId))
        .where(inArray(menuItems.id, itemIds))
    : [];
  const rows = externalOrderRows(order, new Map(stations.map((s) => [s.id, s.station])));

  // The id is minted here so both inserts fit in one batch. A concurrent copy
  // that slips past the check above makes the order insert a no-op and the
  // item insert fail its foreign key, rolling the batch back; we then report
  // the copy that won.
  const orderId = crypto.randomUUID();
  try {
    await db.batch([
      db
        .insert(orders)
        .values({ ...rows.order, id: orderId })
        .onConflictDoNothing({ target: [orders.source, orders.sourceOrderId] }),
      db.insert(orderItems).values(rows.items.map((i) => ({ ...i, orderId }))),
    ]);
  } catch (err) {
    const winner = await existing();
    if (winner) return { orderId: winner.id, duplicate: true };
    throw err;
  }
  return { orderId, duplicate: false };
}
