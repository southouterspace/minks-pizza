import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db, orderItems, orders, storeSettings } from "@/db";
import { syncStockOuts } from "@/lib/inventory";
import { RECALLABLE } from "@/lib/order-workflow";
import type { Actor } from "@/lib/order-writes";
import {
  bumpPlan,
  type KdsAction,
  type KdsItem,
  type KdsOrder,
  type KdsSnapshot,
  type WorkStage,
} from "@/lib/kds";
import { complete, fireDue, recall, run, syncStatus } from "@/lib/orders-server/folds";
import { fulfillmentOf } from "@/lib/orders-server/rows";

const LINE_STATUSES = ["new", "preparing"] as const;
const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;
const CANCELED_WINDOW_MS = 30 * 60 * 1000;

type OrderRow = typeof orders.$inferSelect & {
  items: (typeof orderItems.$inferSelect)[];
};

function kdsItems(o: OrderRow): KdsItem[] {
  return o.items
    .filter((i) => i.firedAt !== null)
    .map((i) => ({
      id: i.id,
      name: i.itemName,
      quantity: i.quantity,
      station: i.station,
      modifiers: i.modifiers,
      notes: i.notes,
      ovenAt: i.ovenAt?.toISOString() ?? null,
      doneAt: i.doneAt?.toISOString() ?? null,
      voidedAt: i.voidedAt?.toISOString() ?? null,
    }));
}

const ticketKey = (o: Pick<OrderRow, "id" | "ticketOrderId">) => o.ticketOrderId ?? o.id;

/** The orders riding on one kitchen ticket: the parent and any checks split off it. */
const onTicket = (ticketId: string) => or(eq(orders.id, ticketId), eq(orders.ticketOrderId, ticketId));

/**
 * Folds checks split off a parent back onto the parent's ticket, so the
 * kitchen keeps seeing one ticket for one table's food. `numbers` names
 * tickets whose parent is not among `rows` (it moved on to another list).
 */
function toTickets(rows: OrderRow[], numbers: ReadonlyMap<string, number>): KdsOrder[] {
  const byTicket = Map.groupBy(rows, ticketKey);
  return [...byTicket.entries()].map(([key, group]) => {
    const head = group.find((o) => o.id === key) ?? group[0];
    return {
      id: key,
      number: numbers.get(key) ?? head.orderNumber,
      // A started check makes the ticket preparing; a check still on the shelf keeps it ready.
      status: (["preparing", "ready"] as const).find((s) => group.some((o) => o.status === s)) ?? head.status,
      source: head.source,
      fulfillment: fulfillmentOf(head),
      fireAt: head.fireAt?.toISOString() ?? null,
      promisedAt: head.promisedAt?.toISOString() ?? null,
      customerName: head.customerName,
      customerPhone: head.customerPhone,
      notes: head.orderNotes,
      placedAt: head.placedAt.toISOString(),
      readyAt: head.readyAt?.toISOString() ?? null,
      items: group.flatMap(kdsItems).toSorted((a, b) => a.id - b.id),
    };
  });
}

/** Ticket numbers for split checks whose parent row is not in the same list. */
async function orphanTicketNumbers(lists: OrderRow[][]): Promise<Map<string, number>> {
  const orphans = lists.flatMap((rows) => {
    const ids = new Set(rows.map((o) => o.id));
    return rows.map(ticketKey).filter((key) => !ids.has(key));
  });
  if (orphans.length === 0) return new Map();
  const parents = await db
    .select({ id: orders.id, number: orders.orderNumber })
    .from(orders)
    .where(inArray(orders.id, [...new Set(orphans)]));
  return new Map(parents.map((p) => [p.id, p.number]));
}

/** The orders on one ticket that are still on the line. */
function lineGroup(ticketId: string) {
  return db.query.orders.findMany({
    where: and(onTicket(ticketId), inArray(orders.status, [...LINE_STATUSES])),
    with: { items: true },
  });
}

export async function getKdsSnapshot(): Promise<KdsSnapshot> {
  const now = new Date();
  await fireDue(now);
  const recentSince = new Date(now.getTime() - RECENT_WINDOW_MS);
  const canceledSince = new Date(now.getTime() - CANCELED_WINDOW_MS);

  const [settingsRows, line, ready, recent, canceled, [avg]] = await Promise.all([
    db
      .select({
        warnMinutes: storeSettings.kdsWarnMinutes,
        lateMinutes: storeSettings.kdsLateMinutes,
        ovenMinutes: storeSettings.kdsOvenMinutes,
      })
      .from(storeSettings)
      .where(eq(storeSettings.id, 1)),
    db.query.orders.findMany({
      where: inArray(orders.status, [...LINE_STATUSES]),
      with: { items: true },
      orderBy: [asc(orders.placedAt)],
    }),
    db.query.orders.findMany({
      where: eq(orders.status, "ready"),
      with: { items: true },
      orderBy: [asc(orders.readyAt)],
    }),
    db.query.orders.findMany({
      where: and(
        inArray(orders.status, ["ready", "completed"]),
        gte(orders.readyAt, recentSince),
      ),
      with: { items: true },
      orderBy: [desc(orders.readyAt)],
      limit: 15,
    }),
    db
      .select({ id: orders.id, number: orders.orderNumber })
      .from(orders)
      .where(and(eq(orders.status, "canceled"), gte(orders.updatedAt, canceledSince))),
    db
      .select({
        seconds: sql<string | null>`avg(extract(epoch from ${orders.readyAt} - ${orders.placedAt}))`,
      })
      .from(orders)
      .where(gte(orders.readyAt, recentSince)),
  ]);

  const timing = settingsRows[0] ?? { warnMinutes: 10, lateMinutes: 15, ovenMinutes: 7 };
  const numbers = await orphanTicketNumbers([line, ready, recent]);
  return {
    serverNow: now.toISOString(),
    timing,
    line: toTickets(line, numbers),
    ready: toTickets(ready, numbers),
    recent: toTickets(recent, numbers),
    canceled,
    avgTicketSeconds: avg?.seconds == null ? null : Math.round(Number(avg.seconds)),
  };
}

function stageColumns(stage: WorkStage, now: Date) {
  switch (stage) {
    case "queued":
      return { ovenAt: null, doneAt: null };
    case "oven":
      // Keep the original oven time if the pie is already in.
      return { ovenAt: sql`coalesce(${orderItems.ovenAt}, ${now})`, doneAt: null };
    case "done":
      return { doneAt: now };
  }
}

/**
 * Applies one display action. Every action is idempotent: replays are
 * harmless, and only status changes that actually happen are logged (the
 * fold in orders-server/folds.ts derives the status from the item stamps).
 */
export async function applyKdsAction(
  action: KdsAction,
  operator: { id: number; name: string },
): Promise<void> {
  const now = new Date();
  const actor: Actor = { name: `Kitchen display · ${operator.name}`, operatorId: operator.id, employeeId: null };

  if (action.type === "item") {
    const [item] = await db
      .select({ orderId: orderItems.orderId, station: orderItems.station })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orderItems.id, action.itemId),
          isNull(orderItems.voidedAt),
          inArray(orders.status, [...LINE_STATUSES]),
        ),
      );
    if (!item) return;
    // Only pies go through the oven.
    const stage = action.stage === "oven" && item.station !== "pizza" ? "done" : action.stage;
    await db.batch([
      db.update(orderItems).set(stageColumns(stage, now)).where(eq(orderItems.id, action.itemId)),
      ...syncStatus(item.orderId, actor),
    ]);
    return;
  }

  if (action.type === "bump") {
    const group = await lineGroup(action.orderId);
    if (group.length === 0) return;
    const [ticket] = toTickets(group, new Map());
    const plan = bumpPlan(ticket, action.view);
    const ids = (stage: WorkStage) => plan.filter((p) => p.stage === stage).map((p) => p.item.id);
    const moves = (["oven", "done"] as const)
      .map((stage) => ({ stage, ids: ids(stage) }))
      .filter((m) => m.ids.length > 0)
      .map((m) =>
        db.update(orderItems).set(stageColumns(m.stage, now)).where(inArray(orderItems.id, m.ids)),
      );
    await run([...moves, ...group.flatMap((o) => syncStatus(o.id, actor))]);
    return;
  }

  if (action.type === "recall") {
    const recallable = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(onTicket(action.orderId), inArray(orders.status, [...RECALLABLE])));
    if (recallable.length === 0) return;
    await run(recall(recallable.map((o) => o.id), actor));
    return;
  }

  const ready = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(onTicket(action.orderId), eq(orders.status, "ready")));
  await run(complete(ready.map((o) => o.id), actor));
}
