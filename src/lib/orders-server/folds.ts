/**
 * The folds: convergent statements that derive an order's money columns
 * from its facts and its kitchen status from its line stamps. Every write
 * batch ends with them, so a replayed or half-retried write lands on the
 * same end state.
 */
import { and, eq, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db, orderItems, orders } from "@/db";

export type Statement = BatchItem<"pg">;

export async function run(statements: Statement[]): Promise<void> {
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
}

function recomputeTotals(orderId: string): Statement {
  return db.execute(sql`
    update orders o set
      subtotal_cents = f.subtotal,
      discount_cents = f.discount,
      tax_cents = f.tax,
      total_cents = f.subtotal - f.discount + f.tax + o.delivery_fee_cents + o.tip_cents,
      paid_cents = f.paid,
      refunded_cents = f.refunded,
      updated_at = now()
    from (
      select x.subtotal, least(x.subtotal, x.adjusted) as discount,
        round((x.subtotal - least(x.subtotal, x.adjusted)) * r.tax_rate_bps / 10000.0)::int as tax,
        x.paid, x.refunded
      from orders r, (
        select
          coalesce((select sum(i.line_total_cents) from order_items i
                    where i.order_id = ${orderId} and i.voided_at is null), 0)::int as subtotal,
          coalesce((select sum(a.cents) from adjustments a
                    where a.order_id = ${orderId}
                      and (a.line_uid is null or exists (
                        select 1 from order_items i
                        where i.line_uid = a.line_uid and i.order_id = ${orderId} and i.voided_at is null))), 0)::int as adjusted,
          coalesce((select sum(t.amount_cents) from tenders t
                    where t.order_id = ${orderId} and t.direction = 'payment'), 0)::int as paid,
          coalesce((select sum(t.amount_cents) from tenders t
                    where t.order_id = ${orderId} and t.direction = 'refund'), 0)::int as refunded
      ) x
      where r.id = ${orderId}
    ) f
    where o.id = ${orderId}`);
}

/**
 * Kitchen status from line stamps. held → new once a live line is fired;
 * new → preparing once one is touched; → ready once every fired live line
 * that needs cooking is done; ready/completed → new when lines are fired
 * onto the check after it was ready. Canceled is terminal and only `cancel`
 * sets it. Fire stamps and ready_at both come from the database clock
 * (fireStamp, insertLines): an app server clock that lags it would make a
 * course fired just after ready look older than the ready stamp.
 */
export function syncStatus(orderId: string): Statement[] {
  const fired = sql`exists (select 1 from order_items i where i.order_id = ${orderId}
    and i.fired_at is not null and i.voided_at is null)`;
  const pending = sql`exists (select 1 from order_items i where i.order_id = ${orderId}
    and i.fired_at is not null and i.voided_at is null and i.station <> 'counter' and i.done_at is null)`;
  const firedSinceReady = sql`exists (select 1 from order_items i where i.order_id = ${orderId}
    and i.fired_at > ${orders.readyAt} and i.voided_at is null and i.station <> 'counter'
    and i.done_at is null)`;
  const touched = sql`exists (select 1 from order_items i where i.order_id = ${orderId}
    and i.voided_at is null and (i.oven_at is not null or i.done_at is not null))`;
  return [
    db
      .update(orders)
      .set({ status: "new", updatedAt: sql`now()` })
      .where(and(eq(orders.id, orderId), eq(orders.status, "held"), fired)),
    db
      .update(orders)
      .set({ status: "new", readyAt: null, updatedAt: sql`now()` })
      .where(and(eq(orders.id, orderId), inArray(orders.status, ["ready", "completed"]), firedSinceReady)),
    db
      .update(orders)
      .set({ status: "preparing", updatedAt: sql`now()` })
      .where(and(eq(orders.id, orderId), eq(orders.status, "new"), touched)),
    db
      .update(orders)
      .set({ status: "ready", readyAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(eq(orders.id, orderId), inArray(orders.status, ["new", "preparing"]), fired, sql`not ${pending}`),
      ),
  ];
}

export function folds(orderId: string): Statement[] {
  return [recomputeTotals(orderId), ...syncStatus(orderId)];
}

/** Sends the matching live lines to the kitchen; lines already fired keep their stamp. */
export function fireStamp(where: SQL | undefined): Statement {
  return db
    .update(orderItems)
    .set({ firedAt: sql`coalesce(${orderItems.firedAt}, now())` })
    .where(and(where, isNull(orderItems.voidedAt)));
}

/**
 * Fires every held order whose fire time has come. Runs on each KDS and POS
 * board poll, so scheduled orders fire whenever any screen is open.
 */
export async function fireDue(now: Date): Promise<number> {
  const due = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, "held"), lte(orders.fireAt, now)));
  if (due.length === 0) return 0;
  const ids = due.map((d) => d.id);
  await run([fireStamp(inArray(orderItems.orderId, ids)), ...ids.flatMap(folds)]);
  return ids.length;
}
