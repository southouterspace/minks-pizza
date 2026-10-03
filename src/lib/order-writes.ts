// Not server-only: the order e2e and the loyalty tests transition orders the way the app does.
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db, orderEvents, orders } from "@/db";
import type { BatchItem } from "drizzle-orm/batch";
import { cancellationStatements, completionStatements } from "@/lib/loyalty-server";
import {
  canTransition,
  COOKING_STATUSES,
  STATUS_META,
  statusTimestamps,
  type OrderEventType,
  type OrderStatus,
  type StatusTimestamps,
} from "@/lib/order-workflow";

/**
 * Who did it, as the audit trail records it: an operator in the admin, an
 * employee at the POS (with the manager who approved, when one did), the
 * kitchen display, or nobody in particular (the customer, the scheduler).
 */
export type Actor = {
  name: string;
  operatorId: number | null;
  employeeId: number | null;
  approvedBy?: number | null;
};

export const CUSTOMER: Actor = { name: "Customer", operatorId: null, employeeId: null };
export const SCHEDULER: Actor = { name: "Scheduler", operatorId: null, employeeId: null };

export type OrderActionResult = { ok: true } | { ok: false; reason: string };

const STALE = "This order changed on another screen. Refresh and try again.";

/**
 * One statement that locks the order when `where` holds, applies `set`, and
 * appends the matching event, so a change and its audit row land together or
 * not at all. Returns the logged rows: none means the guard did not match
 * (another screen got there first). Drizzle's insert-select builder cannot
 * express a data-modifying CTE, hence the SQL template. Stamps use the
 * database clock, like fired_at and ready_at, so the fold's "fired since
 * ready" comparison never depends on an app server's clock.
 */
function loggedUpdate(args: {
  orderId: string;
  where: SQL;
  set: SQL;
  type: OrderEventType;
  toStatus?: OrderStatus;
  note?: string | null;
  actor: Actor;
}) {
  return db.execute<{ order_id: string; from_status: OrderStatus }>(sql`
    with prev as (
      select ${orders.id} as id, ${orders.status} as status
      from ${orders}
      where ${orders.id} = ${args.orderId} and ${args.where}
      for update
    ), moved as (
      update ${orders} set ${args.set}, updated_at = now()
      from prev
      where ${orders.id} = prev.id
      returning prev.id, prev.status
    )
    insert into ${orderEvents}
      (order_id, type, from_status, to_status, actor, operator_id, employee_id, approved_by, note, created_at)
    select id, ${args.type}::order_event_type,
      ${args.toStatus ? sql`status` : sql`null::order_status`},
      ${args.toStatus ?? null}::order_status,
      ${args.actor.name}, ${args.actor.operatorId}::integer, ${args.actor.employeeId}::integer,
      ${args.actor.approvedBy ?? null}::integer, ${args.note ?? null},
      now()
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
 * `statusTimestamps` names, followed by what entering `to` sets off. `when`
 * adds a condition (the fold uses it to move only when the items say so);
 * `also` adds assignments to the same update. Spread into a `db.batch`; the
 * first result is the move's logged rows.
 */
export function transitionStatements(args: {
  orderId: string;
  from: readonly OrderStatus[];
  to: OrderStatus;
  actor: Actor;
  note?: string | null;
  cancelReason?: string | null;
  when?: SQL;
  also?: SQL[];
}) {
  const assignments = [sql`status = ${args.to}::order_status`, ...(args.also ?? [])];
  const stamps = statusTimestamps(args.to, new Date());
  for (const key of Object.keys(stamps) as (keyof StatusTimestamps)[]) {
    const column = sql.identifier(orders[key].name);
    assignments.push(sql`${column} = ${stamps[key] instanceof Date ? sql`now()` : sql`null`}`);
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
  });
  return [move, ...(ON_ENTER[args.to]?.(args.orderId) ?? [])] as const;
}

/** The admin's manual move along the forward table (today only ready → completed). */
export async function transitionOrder(args: {
  orderId: string;
  to: OrderStatus;
  actor: Actor;
  note?: string | null;
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
  const [{ rows }] = await db.batch(transitionStatements({ ...args, from: [order.status] }));
  return rows.length > 0 ? { ok: true } : { ok: false, reason: STALE };
}

export async function adjustPromisedTime(args: {
  orderId: string;
  minutes: number;
  actor: Actor;
}): Promise<OrderActionResult> {
  const sign = args.minutes >= 0 ? "+" : "−";
  const { rows } = await loggedUpdate({
    orderId: args.orderId,
    where: inArray(orders.status, [...COOKING_STATUSES]),
    set: sql`promised_at = coalesce(promised_at, now()) + make_interval(mins => ${args.minutes}::integer)`,
    type: "eta_changed",
    note: `${sign}${Math.abs(args.minutes)} min`,
    actor: args.actor,
  });
  return rows.length > 0
    ? { ok: true }
    : { ok: false, reason: "Only orders still cooking have a promised time to change." };
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
    employeeId: args.actor.employeeId,
    note: args.note,
  });
  return { ok: true };
}
