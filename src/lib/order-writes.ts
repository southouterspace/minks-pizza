// Not server-only: the order e2e and the loyalty tests transition orders the way the app does.
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db, orderDiscounts, orderEvents, orders } from "@/db";
import { inventorySyncStatement, planOrderUsage, syncStockOuts } from "@/lib/inventory";
import { bpsOf, formatCents } from "@/lib/money";
import { getSettings } from "@/lib/orders";
import { discountedTotals } from "@/lib/promotion-engine";
import type { BatchItem } from "drizzle-orm/batch";
import { cancellationStatements, completionStatements } from "@/lib/loyalty-server";
import {
  canComp,
  canTransition,
  COOKING_STATUSES,
  PAYMENT_METHOD_LABEL,
  STATUS_META,
  statusTimestamps,
  type OrderEventType,
  type OrderStatus,
  type PaymentMethod,
  type StatusTimestamps,
} from "@/lib/order-workflow";

/** Who did it, as the audit trail records it. */
export type Actor = { name: string; operatorId: number | null };

export type OrderActionResult = { ok: true } | { ok: false; reason: string };

const STALE = "This order changed on another screen. Refresh and try again.";

/**
 * One statement that locks the order when `where` holds, applies `set`, and
 * appends the matching event, so a change and its audit row land together or
 * not at all. Returns the logged rows: none means the guard did not match
 * (another screen got there first). Drizzle's insert-select builder cannot
 * express a data-modifying CTE, hence the SQL template.
 *
 * `ledger`, when given, is one more data-modifying statement over `prev`
 * (a discount row in or out); the update only runs when it touched a row.
 */
function loggedUpdate(args: {
  orderId: string;
  where: SQL;
  set: SQL;
  ledger?: SQL;
  type: OrderEventType;
  toStatus?: OrderStatus;
  note?: string | null;
  actor: Actor;
  now: Date;
}) {
  const now = args.now.toISOString();
  return db.execute<{ order_id: string; from_status: OrderStatus }>(sql`
    with prev as (
      select ${orders.id} as id, ${orders.status} as status
      from ${orders}
      where ${orders.id} = ${args.orderId} and ${args.where}
      for update
    )${args.ledger ? sql`, ledger as (${args.ledger})` : sql``}, moved as (
      update ${orders} set ${args.set}, updated_at = ${now}::timestamptz
      from prev${args.ledger ? sql`, (select 1 from ledger limit 1) as touched` : sql``}
      where ${orders.id} = prev.id
      returning prev.id, prev.status
    )
    insert into ${orderEvents}
      (order_id, type, from_status, to_status, actor, operator_id, note, created_at)
    select id, ${args.type}::order_event_type,
      ${args.toStatus ? sql`status` : sql`null::order_status`},
      ${args.toStatus ?? null}::order_status,
      ${args.actor.name}, ${args.actor.operatorId}::integer, ${args.note ?? null},
      ${now}::timestamptz
    from moved
    returning order_id, from_status
  `);
}

/**
 * What entering a status sets off besides the move. Each statement re-checks
 * the status in SQL, so it does nothing when the move's guard didn't match.
 */
const ON_ENTER: Partial<Record<OrderStatus, (orderId: string) => BatchItem<"pg">[]>> = {
  completed: completionStatements,
  canceled: cancellationStatements,
};

/**
 * A logged status move from any of `from` into `to`, stamping the columns
 * `statusTimestamps` names, followed by what entering `to` sets off and, when
 * the move enters or leaves `completed`, the stock reconcile (a completed
 * order holds its usage; any other holds none). `when` adds a condition (the
 * KDS uses it to move only when the items say so). Spread into a `db.batch`;
 * the first result is the move's logged rows. Call `syncStockOuts` after the
 * batch commits.
 */
export async function transitionStatements(args: {
  orderId: string;
  from: readonly OrderStatus[];
  to: OrderStatus;
  actor: Actor;
  now: Date;
  note?: string | null;
  cancelReason?: string | null;
  when?: SQL;
}) {
  const assignments = [sql`status = ${args.to}::order_status`];
  const stamps = statusTimestamps(args.to, args.now);
  for (const key of Object.keys(stamps) as (keyof StatusTimestamps)[]) {
    const column = sql.identifier(orders[key].name);
    assignments.push(sql`${column} = ${stamps[key]?.toISOString() ?? null}::timestamptz`);
  }
  if (args.cancelReason) assignments.push(sql`cancel_reason = ${args.cancelReason}`);
  const move = loggedUpdate({
    orderId: args.orderId,
    where: and(inArray(orders.status, [...args.from]), args.when)!,
    set: sql.join(assignments, sql`, `),
    type: "status_changed",
    toStatus: args.to,
    note: args.note ?? args.cancelReason ?? null,
    actor: args.actor,
    now: args.now,
  });
  const stock =
    args.to === "completed" || args.from.includes("completed")
      ? [inventorySyncStatement(await planOrderUsage(args.orderId))]
      : [];
  return [move, ...(ON_ENTER[args.to]?.(args.orderId) ?? []), ...stock] as const;
}

export async function transitionOrder(args: {
  orderId: string;
  to: OrderStatus;
  actor: Actor;
  note?: string | null;
  cancelReason?: string | null;
}): Promise<OrderActionResult> {
  const [order] = await db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, args.orderId));
  if (!order) return { ok: false, reason: "Order not found." };
  if (!canTransition(order.status, args.to)) {
    return {
      ok: false,
      reason: `Order is already ${STATUS_META[order.status].label.toLowerCase()}.`,
    };
  }
  if (args.to === "canceled" && !args.cancelReason) {
    return { ok: false, reason: "Pick a reason for canceling." };
  }
  const [{ rows }] = await db.batch(await transitionStatements({ ...args, from: [order.status], now: new Date() }));
  if (rows.length === 0) return { ok: false, reason: STALE };
  await syncStockOuts({ orderId: args.orderId });
  return { ok: true };
}

export async function adjustPromisedTime(args: {
  orderId: string;
  minutes: number;
  actor: Actor;
}): Promise<OrderActionResult> {
  const now = new Date();
  const sign = args.minutes >= 0 ? "+" : "−";
  const { rows } = await loggedUpdate({
    orderId: args.orderId,
    where: inArray(orders.status, [...COOKING_STATUSES]),
    set: sql`promised_at = coalesce(promised_at, ${now.toISOString()}::timestamptz) + make_interval(mins => ${args.minutes}::integer)`,
    type: "eta_changed",
    note: `${sign}${Math.abs(args.minutes)} min`,
    actor: args.actor,
    now,
  });
  return rows.length > 0
    ? { ok: true }
    : { ok: false, reason: "Only orders still cooking have a promised time to change." };
}

export async function recordPayment(args: {
  orderId: string;
  method: PaymentMethod;
  actor: Actor;
}): Promise<OrderActionResult> {
  const { rows } = await loggedUpdate({
    orderId: args.orderId,
    where: eq(orders.paymentStatus, "pending"),
    set: sql`payment_status = 'paid', payment_method = ${args.method}::payment_method`,
    type: "payment_recorded",
    note: PAYMENT_METHOD_LABEL[args.method],
    actor: args.actor,
    now: new Date(),
  });
  return rows.length > 0
    ? { ok: true }
    : { ok: false, reason: "Payment is already recorded for this order." };
}

export async function addOrderNote(args: {
  orderId: string;
  note: string;
  actor: Actor;
}): Promise<OrderActionResult> {
  const [order] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, args.orderId));
  if (!order) return { ok: false, reason: "Order not found." };
  await db.insert(orderEvents).values({
    orderId: order.id,
    type: "note_added",
    actor: args.actor.name,
    operatorId: args.actor.operatorId,
    note: args.note,
  });
  return { ok: true };
}


const DISCOUNT_LOCKED = "Discounts can only change while the order is open and payment is still pending.";

/**
 * A discount row in or out, with tax and total recomputed in the same
 * statement. Tax uses the store's current rate. The guard includes the
 * discount total read here, so two screens editing at once can't both win.
 */
async function changeDiscount(args: {
  orderId: string;
  actor: Actor;
  compute: (order: typeof orders.$inferSelect, rows: (typeof orderDiscounts.$inferSelect)[]) =>
    | { error: string }
    | { ledger: SQL; discounts: { amountCents: number; target: "items" | "delivery" }[]; note: string };
}): Promise<OrderActionResult> {
  const [order, settings] = await Promise.all([
    db.query.orders.findFirst({ where: eq(orders.id, args.orderId), with: { discounts: true } }),
    getSettings(),
  ]);
  if (!order) return { ok: false, reason: "Order not found." };
  if (!canComp(order)) return { ok: false, reason: DISCOUNT_LOCKED };
  const change = args.compute(order, order.discounts);
  if ("error" in change) return { ok: false, reason: change.error };
  const totals = discountedTotals({
    subtotalCents: order.subtotalCents,
    deliveryFeeCents: order.deliveryFeeCents,
    tipCents: order.tipCents,
    taxRateBps: settings.taxRateBps,
    discounts: change.discounts,
  });
  const { rows } = await loggedUpdate({
    orderId: args.orderId,
    // canComp, in SQL, plus the discount total read above.
    where: sql`${orders.paymentStatus} = 'pending' and ${orders.status} not in ('canceled', 'completed') and ${orders.discountCents} = ${order.discountCents}`,
    ledger: change.ledger,
    set: sql`discount_cents = ${totals.discountCents}, tax_cents = ${totals.taxCents}, total_cents = ${totals.totalCents}`,
    type: "discount",
    note: change.note,
    actor: args.actor,
    now: new Date(),
  });
  return rows.length > 0 ? { ok: true } : { ok: false, reason: STALE };
}

/** An operator comp: a fixed amount or a percent of what is left of the items. */
export async function applyDiscount(args: {
  orderId: string;
  amount: { cents: number } | { percentBps: number };
  label: string;
  promotionId: number | null;
  actor: Actor;
}): Promise<OrderActionResult> {
  return changeDiscount({
    orderId: args.orderId,
    actor: args.actor,
    compute: (order, rows) => {
      const itemsLeft =
        order.subtotalCents - rows.filter((r) => r.target === "items").reduce((n, r) => n + r.amountCents, 0);
      const cents =
        "cents" in args.amount
          ? Math.min(args.amount.cents, itemsLeft)
          : Math.min(itemsLeft, bpsOf(itemsLeft, args.amount.percentBps));
      if (cents <= 0) return { error: "Nothing left on the items to discount." };
      return {
        ledger: sql`
          insert into ${orderDiscounts} (order_id, promotion_id, label, amount_cents, target, source, operator_id)
          select id, ${args.promotionId}::integer, ${args.label}, ${cents}::integer, 'items', 'comp',
            ${args.actor.operatorId}::integer
          from prev
          returning id`,
        discounts: [...rows, { amountCents: cents, target: "items" as const }],
        note: `−${formatCents(cents)} · ${args.label}`,
      };
    },
  });
}

export async function removeDiscount(args: {
  orderId: string;
  discountId: number;
  actor: Actor;
}): Promise<OrderActionResult> {
  return changeDiscount({
    orderId: args.orderId,
    actor: args.actor,
    compute: (_order, rows) => {
      const row = rows.find((r) => r.id === args.discountId);
      if (!row) return { error: "That discount is already gone." };
      if (row.source !== "comp") return { error: "Only staff discounts can be removed here." };
      return {
        ledger: sql`
          delete from ${orderDiscounts}
          where ${orderDiscounts.id} = ${row.id} and ${orderDiscounts.orderId} = (select id from prev)
          returning ${orderDiscounts.id}`,
        discounts: rows.filter((r) => r.id !== row.id),
        note: `Removed −${formatCents(row.amountCents)} · ${row.label}`,
      };
    },
  });
}
