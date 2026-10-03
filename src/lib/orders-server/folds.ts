/**
 * The folds: convergent statements that derive an order's money columns
 * from its facts and its kitchen status from its line stamps. Every order
 * write batch ends with them, so a replayed or half-retried write lands on
 * the same end state. Each status edge is a logged transition
 * (order-writes.ts), so a move writes its audit row only when it happens.
 * Kitchen status otherwise moves only along the named edges at the end of
 * this file.
 */
import { and, eq, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db, orderItems, orders } from "@/db";
import { inventorySyncStatement, planOrderUsage, syncStockOuts } from "@/lib/inventory";
import { ACTIVE_STATUSES, RECALLABLE } from "@/lib/order-workflow";
import { SCHEDULER, transitionStatements, type Actor } from "@/lib/order-writes";
import { MARKETPLACE_SOURCES } from "@/lib/orders";

export type Statement = BatchItem<"pg">;

/**
 * Runs a batch and, when its stock reconcile moved anything, brings the
 * 86 list in line (that needs the moves committed, so it runs after).
 */
export async function run(statements: Statement[]): Promise<void> {
  const [first, ...rest] = statements;
  if (!first) return;
  const results = await db.batch([first, ...rest]);
  const moved = results.flatMap((r) => (isMoves(r) ? r.rows : []));
  if (moved.length > 0) await syncStockOuts({ orderId: moved[0].order_id });
}

type MoveRow = { order_id: string; ingredient_id: number };

function isMoves(result: unknown): result is { rows: MoveRow[] } {
  return (
    typeof result === "object" &&
    result !== null &&
    "rows" in result &&
    Array.isArray(result.rows) &&
    result.rows.length > 0 &&
    typeof result.rows[0] === "object" &&
    result.rows[0] !== null &&
    "ingredient_id" in result.rows[0] &&
    "order_id" in result.rows[0]
  );
}

const EXTERNAL = sql.raw(MARKETPLACE_SOURCES.map((s) => `'${s}'`).join(", "));

/**
 * Money from the rows: subtotal over live lines, discounts capped at what
 * they apply to (items rows whose line is live, delivery rows at the fee),
 * tax on items after item discounts at the order's own rate, paid and
 * refunded from the tenders. A marketplace order keeps the totals its
 * platform sent (its tax is the platform's, not ours); only its payments fold.
 */
function recomputeTotals(orderId: string): Statement {
  const external = sql`o.source in (${EXTERNAL})`;
  return db.execute(sql`
    update orders o set
      subtotal_cents = case when ${external} then o.subtotal_cents else f.subtotal end,
      discount_cents = case when ${external} then o.discount_cents else f.items_off + f.delivery_off end,
      tax_cents = case when ${external} then o.tax_cents else f.tax end,
      total_cents = case when ${external} then o.total_cents
        else f.subtotal - f.items_off - f.delivery_off + f.tax + o.delivery_fee_cents + o.tip_cents end,
      paid_cents = f.paid,
      refunded_cents = f.refunded,
      updated_at = now()
    from (
      select y.subtotal, y.items_off, y.delivery_off,
        round((y.subtotal - y.items_off) * y.bps / 10000.0)::int as tax, y.paid, y.refunded
      from (
        select x.subtotal, least(x.subtotal, x.items_raw) as items_off,
          least(r.delivery_fee_cents, x.delivery_raw) as delivery_off, r.tax_rate_bps as bps, x.paid, x.refunded
        from orders r, (
          select
            coalesce((select sum(i.line_total_cents) from order_items i
                      where i.order_id = ${orderId} and i.voided_at is null), 0)::int as subtotal,
            coalesce((select sum(d.amount_cents) from order_discounts d
                      where d.order_id = ${orderId} and d.target = 'items'
                        and (d.line_uid is null or exists (
                          select 1 from order_items i
                          where i.line_uid = d.line_uid and i.order_id = ${orderId} and i.voided_at is null))), 0)::int as items_raw,
            coalesce((select sum(d.amount_cents) from order_discounts d
                      where d.order_id = ${orderId} and d.target = 'delivery'), 0)::int as delivery_raw,
            coalesce((select sum(t.amount_cents) from tenders t
                      where t.order_id = ${orderId} and t.direction = 'payment'), 0)::int as paid,
            coalesce((select sum(t.amount_cents) from tenders t
                      where t.order_id = ${orderId} and t.direction = 'refund'), 0)::int as refunded
        ) x
        where r.id = ${orderId}
      ) y
    ) f
    where o.id = ${orderId}`);
}

/**
 * Kitchen status from line stamps. held → new once a live line is fired;
 * new → preparing once one is touched; → ready once every fired live line
 * that needs cooking is done; ready/completed → new when lines are fired
 * onto the check after it was ready. Canceled is terminal and only `cancel`
 * sets it. Fire stamps and ready_at both come from the database clock
 * (fireStamp, insertLines, transitionStatements): an app server clock that
 * lags it would make a course fired just after ready look older than the
 * ready stamp.
 */
export function syncStatus(orderId: string, actor: Actor): Statement[] {
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
    ...transitionStatements({ orderId, from: ["held"], to: "new", actor, when: fired }),
    ...transitionStatements({ orderId, from: RECALLABLE, to: "new", actor, when: firedSinceReady }),
    ...transitionStatements({ orderId, from: ["new"], to: "preparing", actor, when: touched }),
    ...transitionStatements({
      orderId,
      from: ["new", "preparing"],
      to: "ready",
      actor,
      when: sql`${fired} and not ${pending}`,
    }),
  ];
}

/**
 * Money, kitchen status, then stock: the reconcile reads the status the
 * edges above just set, so a completed order holds its usage and any other
 * holds none, whichever path moved it.
 */
export async function folds(orderId: string, actor: Actor): Promise<Statement[]> {
  return [recomputeTotals(orderId), ...syncStatus(orderId, actor), inventorySyncStatement(await planOrderUsage(orderId))];
}

export async function foldsAll(orderIds: string[], actor: Actor): Promise<Statement[]> {
  return (await Promise.all(orderIds.map((id) => folds(id, actor)))).flat();
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
  await run([fireStamp(inArray(orderItems.orderId, ids)), ...(await foldsAll(ids, SCHEDULER))]);
  return ids.length;
}

// ---------------------------------------------------------------------------
// Named status edges: explicit transitions the line stamps can't express
// ---------------------------------------------------------------------------

/** Ready → completed: handed to the customer (POS handoff, KDS bump off the ready shelf). */
export function complete(orderIds: string[], actor: Actor): Statement[] {
  return orderIds.flatMap((orderId) => [...transitionStatements({ orderId, from: ["ready"], to: "completed", actor })]);
}

/** Back on the line from scratch: a recalled ticket usually means a remake. */
export function recall(orderIds: string[], actor: Actor): Statement[] {
  return [
    ...orderIds.flatMap((orderId) => [...transitionStatements({ orderId, from: RECALLABLE, to: "preparing", actor })]),
    db.update(orderItems).set({ ovenAt: null, doneAt: null }).where(inArray(orderItems.orderId, orderIds)),
  ];
}

/** Terminal. The fee and tip go too, so recomputeTotals folds the total to zero once lines are voided. */
export function cancel(orderId: string, actor: Actor, reason: string): Statement[] {
  return [
    ...transitionStatements({
      orderId,
      from: ACTIVE_STATUSES,
      to: "canceled",
      actor,
      cancelReason: reason,
      also: [sql`delivery_fee_cents = 0`, sql`tip_cents = 0`],
    }),
  ];
}
