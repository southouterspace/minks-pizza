import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, orderItems, orders, storeSettings } from "@/db";
import { RECALLABLE } from "@/lib/order-workflow";
import { transitionStatements, type Actor } from "@/lib/order-writes";
import {
  bumpPlan,
  type ItemStage,
  type KdsAction,
  type KdsOrder,
  type KdsSnapshot,
} from "@/lib/kds";

const LINE_STATUSES = ["new", "confirmed", "preparing"] as const;
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
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    address,
    notes: o.orderNotes,
    placedAt: o.placedAt.toISOString(),
    readyAt: o.readyAt?.toISOString() ?? null,
    items: o.items
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
      })),
  };
}

export async function getKdsSnapshot(): Promise<KdsSnapshot> {
  const now = new Date();
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
    line: line.map(toKdsOrder),
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

/**
 * Brings an order's status in line with its items: any kitchen activity
 * starts it (the customer's tracker shows "preparing"), and finishing every
 * item that needs cooking bumps it to ready. Un-finishing an item on a ready
 * order is impossible from the line view, so there is no ready → preparing
 * edge here; that is what recall is for. Each move that happens is logged.
 */
function syncStatus(orderId: string, actor: Actor, now: Date) {
  const pending = db
    .select({ one: sql`1` })
    .from(orderItems)
    .where(
      and(
        eq(orderItems.orderId, orderId),
        ne(orderItems.station, "counter"),
        isNull(orderItems.doneAt),
      ),
    );
  const touched = db
    .select({ one: sql`1` })
    .from(orderItems)
    .where(
      and(
        eq(orderItems.orderId, orderId),
        sql`(${orderItems.ovenAt} is not null or ${orderItems.doneAt} is not null)`,
      ),
    );
  return [
    ...transitionStatements({
      orderId,
      from: ["new", "confirmed"],
      to: "preparing",
      actor,
      now,
      when: sql`exists (${touched})`,
    }),
    ...transitionStatements({
      orderId,
      from: LINE_STATUSES,
      to: "ready",
      actor,
      now,
      when: sql`not exists (${pending})`,
    }),
  ] as const;
}

/**
 * Applies one display action. Every action is idempotent: replays are
 * harmless, and only status changes that actually happen are logged.
 */
export async function applyKdsAction(
  action: KdsAction,
  operator: { id: number; name: string },
): Promise<void> {
  const now = new Date();
  const actor: Actor = { name: `Kitchen display · ${operator.name}`, operatorId: operator.id };

  if (action.type === "item") {
    const [item] = await db
      .select({ orderId: orderItems.orderId, station: orderItems.station })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orderItems.id, action.itemId), inArray(orders.status, [...LINE_STATUSES])));
    if (!item) return;
    // Only pies go through the oven.
    const stage = action.stage === "oven" && item.station !== "pizza" ? "done" : action.stage;
    await db.batch([
      db.update(orderItems).set(stageColumns(stage, now)).where(eq(orderItems.id, action.itemId)),
      ...syncStatus(item.orderId, actor, now),
    ]);
    return;
  }

  if (action.type === "bump") {
    const order = await db.query.orders.findFirst({
      where: and(eq(orders.id, action.orderId), inArray(orders.status, [...LINE_STATUSES])),
      with: { items: true },
    });
    if (!order) return;
    const plan = bumpPlan(toKdsOrder(order), action.view);
    const ids = (stage: ItemStage) => plan.filter((p) => p.stage === stage).map((p) => p.item.id);
    const moves = (["oven", "done"] as const)
      .map((stage) => ({ stage, ids: ids(stage) }))
      .filter((m) => m.ids.length > 0)
      .map((m) =>
        db.update(orderItems).set(stageColumns(m.stage, now)).where(inArray(orderItems.id, m.ids)),
      );
    // syncStatus always contributes statements, so the batch is never empty.
    const [first, ...rest] = [...moves, ...syncStatus(order.id, actor, now)];
    await db.batch([first, ...rest]);
    return;
  }

  if (action.type === "recall") {
    const [order] = await db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, action.orderId));
    if (!order || !RECALLABLE.includes(order.status)) return;
    // Back on the line from scratch: a recalled ticket usually means a remake.
    await db.batch([
      ...transitionStatements({
        orderId: action.orderId,
        from: RECALLABLE,
        to: "preparing",
        actor,
        now,
      }),
      db
        .update(orderItems)
        .set({ ovenAt: null, doneAt: null })
        .where(eq(orderItems.orderId, action.orderId)),
    ]);
    return;
  }

  await db.batch(
    transitionStatements({ orderId: action.orderId, from: ["ready"], to: "completed", actor, now }),
  );
}
