import "server-only";
import { asc, desc, eq, sql } from "drizzle-orm";
import {
  categories,
  db,
  menuItems,
  modifierGroups,
  modifiers,
  orderDiscounts,
  orders,
  promotionCodes,
  promotions,
} from "@/db";
import { toTerms } from "@/lib/promotion-queries";
import { keptLedger, usesOf } from "@/lib/promotion-usage";
import { isOrderReward } from "@/lib/promotion-schema";

export type PromotionStats = {
  /** Redemptions, the number its limits count. */
  uses: number;
  /** Everything taken off under this deal's name, operator comps included. */
  discountedCents: number;
  /** Item subtotal less item discounts, over the non-canceled orders that carry it. */
  netSalesCents: number;
};

const NO_STATS: PromotionStats = { uses: 0, discountedCents: 0, netSalesCents: 0 };

async function statsByPromotion(promotionId?: number): Promise<Map<number, PromotionStats>> {
  const only = promotionId === undefined ? sql`d.promotion_id is not null` : sql`d.promotion_id = ${promotionId}`;
  const { rows } = await db.execute<{
    promotion_id: number;
    uses: string;
    discounted: string;
    net_sales: string;
  }>(sql`
    with touched as (
      select d.promotion_id, d.order_id, sum(d.amount_cents) as amount
      from ${keptLedger} and ${only}
      group by d.promotion_id, d.order_id
    )
    select touched.promotion_id,
      ${usesOf(sql`d.promotion_id = touched.promotion_id`)} as uses,
      sum(touched.amount) as discounted,
      sum(o.subtotal_cents - coalesce((
        select sum(x.amount_cents) from ${orderDiscounts} x
        where x.order_id = o.id and x.target = 'items'
      ), 0)) as net_sales
    from touched join ${orders} o on o.id = touched.order_id
    group by touched.promotion_id
  `);
  return new Map(
    rows.map((r) => [
      Number(r.promotion_id),
      { uses: Number(r.uses), discountedCents: Number(r.discounted), netSalesCents: Number(r.net_sales) },
    ]),
  );
}

export async function listPromotions() {
  const [rows, codes, stats] = await Promise.all([
    db.select().from(promotions).orderBy(asc(promotions.archivedAt), desc(promotions.createdAt)),
    db
      .select({
        promotionId: promotionCodes.promotionId,
        shared: sql<string | null>`min(${promotionCodes.display}) filter (where ${promotionCodes.maxUses} is null)`,
        singleUse: sql<number>`count(*) filter (where ${promotionCodes.maxUses} is not null)`.mapWith(Number),
        total: sql<number>`count(*)`.mapWith(Number),
      })
      .from(promotionCodes)
      .groupBy(promotionCodes.promotionId),
    statsByPromotion(),
  ]);
  const codesOf = new Map(codes.map((c) => [c.promotionId, c]));
  return rows.map((row) => ({
    row,
    terms: toTerms(row),
    codes: codesOf.get(row.id) ?? { shared: null, singleUse: 0, total: 0 },
    stats: stats.get(row.id) ?? NO_STATS,
  }));
}

export const CODES_SHOWN = 100;

export async function getPromotion(id: number) {
  const [row] = await db.select().from(promotions).where(eq(promotions.id, id));
  if (!row) return null;
  const [codes, [{ totalCodes }], stats] = await Promise.all([
    listCodes(id, CODES_SHOWN),
    db
      .select({ totalCodes: sql<number>`count(*)`.mapWith(Number) })
      .from(promotionCodes)
      .where(eq(promotionCodes.promotionId, id)),
    statsByPromotion(id),
  ]);
  return { row, terms: toTerms(row), codes, totalCodes, stats: stats.get(id) ?? NO_STATS };
}

/** A promotion's codes, shared ones first, each with its redemptions. */
export function listCodes(promotionId: number, limit?: number) {
  const query = db
    .select({
      id: promotionCodes.id,
      display: promotionCodes.display,
      maxUses: promotionCodes.maxUses,
      // Spelled out: a bare column here would bind to the subquery's own table.
      uses: sql<number>`${usesOf(sql`d.code_id = promotion_codes.id`)}`.mapWith(Number),
    })
    .from(promotionCodes)
    .where(eq(promotionCodes.promotionId, promotionId))
    .orderBy(sql`${promotionCodes.maxUses} nulls first`, asc(promotionCodes.id));
  return limit === undefined ? query : query.limit(limit);
}

/** Ever redeemed, canceled orders included: such a promotion can be archived but not deleted. */
export async function everUsed(promotionId: number): Promise<boolean> {
  const [hit] = await db
    .select({ id: orderDiscounts.id })
    .from(orderDiscounts)
    .where(eq(orderDiscounts.promotionId, promotionId))
    .limit(1);
  return Boolean(hit);
}

export type MenuCatalog = {
  categories: { id: number; name: string }[];
  items: { id: number; name: string; categoryId: number }[];
  modifierGroups: { id: number; name: string; modifiers: { id: number; name: string }[] }[];
};

/** Everything the target picker offers. */
export async function getMenuCatalog(): Promise<MenuCatalog> {
  const [cats, items, groups, mods] = await Promise.all([
    db.select({ id: categories.id, name: categories.name }).from(categories).orderBy(asc(categories.sortOrder), asc(categories.id)),
    db
      .select({ id: menuItems.id, name: menuItems.name, categoryId: menuItems.categoryId })
      .from(menuItems)
      .orderBy(asc(menuItems.sortOrder), asc(menuItems.id)),
    db.select({ id: modifierGroups.id, name: modifierGroups.name }).from(modifierGroups).orderBy(asc(modifierGroups.sortOrder), asc(modifierGroups.id)),
    db
      .select({ id: modifiers.id, name: modifiers.name, groupId: modifiers.groupId })
      .from(modifiers)
      .orderBy(asc(modifiers.sortOrder), asc(modifiers.id)),
  ]);
  return {
    categories: cats,
    items,
    modifierGroups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      modifiers: mods.filter((m) => m.groupId === g.id).map(({ id, name }) => ({ id, name })),
    })),
  };
}

export function catalogNames(c: MenuCatalog) {
  return {
    categories: Object.fromEntries(c.categories.map((x) => [x.id, x.name])),
    items: Object.fromEntries(c.items.map((x) => [x.id, x.name])),
    modifiers: Object.fromEntries(c.modifierGroups.flatMap((g) => g.modifiers.map((m) => [m.id, m.name]))),
  };
}

/** A comp the operator can fill in with one tap: a live deal's whole-order reward. */
export type DiscountPreset = { promotionId: number; label: string; amount: { cents: number } | { percentBps: number } };

export async function compPresets(): Promise<DiscountPreset[]> {
  const rows = await db
    .select()
    .from(promotions)
    .where(sql`${promotions.isActive} and ${promotions.archivedAt} is null`)
    .orderBy(asc(promotions.id));
  return rows.flatMap((row) => {
    const { reward } = toTerms(row);
    if (!isOrderReward(reward)) return [];
    const amount = reward.type === "order_percent" ? { percentBps: reward.percentBps } : { cents: reward.amountCents };
    return [{ promotionId: row.id, label: row.name, amount }];
  });
}
