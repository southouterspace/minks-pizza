import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db, orderItems, orders, storeSettings } from "@/db";
import {
  bumpPlan,
  type ItemStage,
  type KdsAction,
  type KdsOrder,
  type KdsSnapshot,
} from "@/lib/kds";
import { complete, fireDue, recall, run, syncStatus } from "@/lib/orders-server/folds";

const LINE_STATUSES = ["new", "preparing"] as const;
const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;
const CANCELED_WINDOW_MS = 30 * 60 * 1000;

type OrderRow = typeof orders.$inferSelect & {
  items: (typeof orderItems.$inferSelect)[];
};

function toKdsOrder(o: OrderRow): KdsOrder {
  const address =
    o.orderType === "delivery" && o.addressLine1
      ? [o.addressLine1, o.addressLine2, o.city, o.zip].filter(Boolean).join(", ")
      : null;
  return {
    id: o.id,
    number: o.orderNumber,
    status: o.status,
    type: o.orderType,
    channel: o.channel,
    table: o.tableLabel,
    fireAt: o.fireAt?.toISOString() ?? null,
    promisedAt: o.promisedAt?.toISOString() ?? null,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    address,
    notes: o.orderNotes,
    placedAt: o.placedAt.toISOString(),
    readyAt: o.readyAt?.toISOString() ?? null,
    items: o.items
      .filter((i) => i.firedAt !== null)
      .toSorted((a, b) => a.id - b.id)
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
      })),
  };
}

const ticketKey = (o: Pick<OrderRow, "id" | "ticketOrderId">) => o.ticketOrderId ?? o.id;

/**
 * Folds checks split off a parent back onto the parent's ticket, so the
 * kitchen keeps seeing one ticket for one table's food.
 */
function toTickets(rows: OrderRow[]): KdsOrder[] {
  const byTicket = new Map<string, OrderRow[]>();
  for (const row of rows) byTicket.set(ticketKey(row), [...(byTicket.get(ticketKey(row)) ?? []), row]);
  return [...byTicket.entries()].map(([key, group]) => {
    const head = group.find((o) => o.id === key) ?? group[0];
    const ticket = toKdsOrder(head);
    return {
      ...ticket,
      id: key,
      status: group.some((o) => o.status === "preparing") ? "preparing" : ticket.status,
      items: group.flatMap((o) => toKdsOrder(o).items).toSorted((a, b) => a.id - b.id),
    };
  });
}

/** The orders on one ticket that are still on the line. */
function lineGroup(ticketId: string) {
  return db.query.orders.findMany({
    where: and(
      or(eq(orders.id, ticketId), eq(orders.ticketOrderId, ticketId)),
      inArray(orders.status, [...LINE_STATUSES]),
    ),
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
  return {
    serverNow: now.toISOString(),
    timing,
    line: toTickets(line),
    ready: ready.map(toKdsOrder),
    recent: recent.map(toKdsOrder),
    canceled,
    avgTicketSeconds: avg?.seconds == null ? null : Math.round(Number(avg.seconds)),
  };
}

function stageColumns(stage: ItemStage, now: Date) {
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

/** Applies one display action. Every action is idempotent: replays are harmless. */
export async function applyKdsAction(action: KdsAction): Promise<void> {
  const now = new Date();

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
      ...syncStatus(item.orderId),
    ]);
    return;
  }

  if (action.type === "bump") {
    const group = await lineGroup(action.orderId);
    if (group.length === 0) return;
    const [ticket] = toTickets(group);
    const plan = bumpPlan(ticket, action.view);
    const ids = (stage: ItemStage) => plan.filter((p) => p.stage === stage).map((p) => p.item.id);
    const moves = (["oven", "done"] as const)
      .map((stage) => ({ stage, ids: ids(stage) }))
      .filter((m) => m.ids.length > 0)
      .map((m) =>
        db.update(orderItems).set(stageColumns(m.stage, now)).where(inArray(orderItems.id, m.ids)),
      );
    // syncStatus always contributes statements, so the batch is never empty.
    const [first, ...rest] = [...moves, ...group.flatMap((o) => syncStatus(o.id))];
    await db.batch([first, ...rest]);
    return;
  }

  const onTicket = or(eq(orders.id, action.orderId), eq(orders.ticketOrderId, action.orderId));
  if (action.type === "recall") {
    const recallable = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(onTicket, inArray(orders.status, ["ready", "completed"])));
    if (recallable.length === 0) return;
    await run(recall(recallable.map((o) => o.id)));
    return;
  }

  await run([complete(onTicket)]);
}
