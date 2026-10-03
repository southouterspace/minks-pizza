import "server-only";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db, orderEvents, orders } from "@/db";
import {
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
 */
function loggedUpdate(args: {
  orderId: string;
  where: SQL;
  set: SQL;
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
    ), moved as (
      update ${orders} set ${args.set}, updated_at = ${now}::timestamptz
      from prev where ${orders.id} = prev.id
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
 * A logged status move from any of `from` into `to`, stamping the columns
 * `statusTimestamps` names. `when` adds a condition (the KDS uses it to move
 * only when the items say so). Usable inside a `db.batch`.
 */
export function transitionStatement(args: {
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
  return loggedUpdate({
    orderId: args.orderId,
    where: and(inArray(orders.status, [...args.from]), args.when)!,
    set: sql.join(assignments, sql`, `),
    type: "status_changed",
    toStatus: args.to,
    note: args.note ?? args.cancelReason ?? null,
    actor: args.actor,
    now: args.now,
  });
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
  const { rows } = await transitionStatement({
    ...args,
    from: [order.status],
    now: new Date(),
  });
  return rows.length > 0 ? { ok: true } : { ok: false, reason: STALE };
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

