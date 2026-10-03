/**
 * What a "use" of a promotion is, defined once. Every limit check, usage
 * count and the checkout's redemption guard read from these fragments.
 */
import { sql, type SQL } from "drizzle-orm";
import { db, orderDiscounts, orders, promotions } from "@/db";
import type { AppliedDiscount } from "@/lib/promotion-engine";

/** Ledger rows (aliased d) on orders (aliased o) that weren't canceled, comps included. */
export const keptLedger = sql`${orderDiscounts} d join ${orders} o on o.id = d.order_id where o.status <> 'canceled'`;

/**
 * Redemptions: a promotion's own rows on kept orders, so a cancel gives the
 * use back. Operator comps never use up a deal's limits, even when a preset
 * named the deal; reports still see them through keptLedger.
 */
export const redemptions = sql`${keptLedger} and d.source = 'promotion'`;

/** A scalar subquery counting the redemptions that match `filter` (over d and o). */
export const usesOf = (filter: SQL) => sql`(select count(*) from ${redemptions} and ${filter})`;

/** Uses of each promotion, overall and by one customer. */
export async function promotionUsage(promotionIds: number[], customerKey: string | null) {
  if (promotionIds.length === 0) return new Map<number, { uses: number; customerUses: number }>();
  const { rows } = await db.execute<{ promotion_id: number; uses: string; customer_uses: string }>(sql`
    select d.promotion_id, count(*) as uses, count(*) filter (where o.customer_key = ${customerKey}) as customer_uses
    from ${redemptions} and d.promotion_id in ${promotionIds}
    group by d.promotion_id`);
  return new Map(rows.map((r) => [Number(r.promotion_id), { uses: Number(r.uses), customerUses: Number(r.customer_uses) }]));
}

/** Uses of each code. */
export async function codeUsage(codeIds: number[]) {
  if (codeIds.length === 0) return new Map<number, number>();
  const { rows } = await db.execute<{ code_id: number; uses: string }>(sql`
    select d.code_id, count(*) as uses from ${redemptions} and d.code_id in ${codeIds} group by d.code_id`);
  return new Map(rows.map((r) => [Number(r.code_id), Number(r.uses)]));
}

/** A redeeming insert runs `lock` as its own statement, then an insert conditional on `guard`. */
export type RedemptionCheck = { lock: SQL; guard: SQL };

/**
 * `guard` holds while every applied deal is still live and under its total,
 * per-customer and per-code limits, and (for new-customer deals) the phone
 * has no kept order. `lock` takes the applied promotion rows in id order (none
 * when nothing applies), so two checkouts can't deadlock and one racing for
 * the same promotion waits until the first commits. The guard must run in a later statement than the
 * lock: under read committed that statement takes a fresh snapshot, which
 * includes the winner's order.
 */
export function redemptionCheck(applied: AppliedDiscount[], customerKey: string): RedemptionCheck {
  const ids = [...new Set(applied.map((a) => a.promotionId))].sort((a, b) => a - b);
  const conditions = applied.flatMap(({ promotionId, codeId, limits }) => [
    sql`exists (select 1 from ${promotions} where id = ${promotionId} and is_active and archived_at is null)`,
    ...(limits.totalLimit !== null ? [sql`${usesOf(sql`d.promotion_id = ${promotionId}`)} < ${limits.totalLimit}`] : []),
    ...(limits.perCustomerLimit !== null
      ? [sql`${usesOf(sql`d.promotion_id = ${promotionId} and o.customer_key = ${customerKey}`)} < ${limits.perCustomerLimit}`]
      : []),
    ...(limits.codeMaxUses !== null ? [sql`${usesOf(sql`d.code_id = ${codeId}`)} < ${limits.codeMaxUses}`] : []),
    ...(limits.newCustomersOnly ? [sql`not exists (select 1 from ${orders} where status <> 'canceled' and customer_key = ${customerKey})`] : []),
  ]);
  return {
    lock: sql`select id from ${promotions} where id = any(${sql.param(ids)}::int[]) order by id for update`,
    guard: conditions.length ? sql.join(conditions, sql` and `) : sql`true`,
  };
}
