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
import type { PromotionTerms } from "@/lib/promotions";

export type PromotionStats = {
  uses: number;
  discountedCents: number;
  /** Item subtotal less item discounts, over the non-canceled orders that used it. */
  netSalesCents: number;
};

const NO_STATS: PromotionStats = { uses: 0, discountedCents: 0, netSalesCents: 0 };

async function statsByPromotion(promotionId?: number): Promise<Map<number, PromotionStats>> {
  const only = promotionId === undefined ? sql`true` : sql`d.promotion_id = ${promotionId}`;
  const { rows } = await db.execute<{
    promotion_id: number;
    uses: string;
    discounted: string;
    net_sales: string;
  }>(sql`
    with used as (
      select d.promotion_id, d.order_id, sum(d.amount_cents) as amount
      from ${orderDiscounts} d join ${orders} o on o.id = d.order_id
      where d.promotion_id is not null and o.status <> 'canceled' and ${only}
      group by d.promotion_id, d.order_id
    )
    select used.promotion_id,
      count(*) as uses,
      sum(used.amount) as discounted,
      sum(o.subtotal_cents - coalesce((
        select sum(x.amount_cents) from ${orderDiscounts} x
        where x.order_id = o.id and x.target = 'items'
      ), 0)) as net_sales
    from used join ${orders} o on o.id = used.order_id
    group by used.promotion_id
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
    db
      .select({
        id: promotionCodes.id,
        display: promotionCodes.display,
        maxUses: promotionCodes.maxUses,
        createdAt: promotionCodes.createdAt,
        uses: sql<number>`(select count(*) from ${orderDiscounts} d join ${orders} o on o.id = d.order_id
          where d.code_id = promotion_codes.id and o.status <> 'canceled')`.mapWith(Number),
      })
      .from(promotionCodes)
      .where(eq(promotionCodes.promotionId, id))
      .orderBy(sql`${promotionCodes.maxUses} nulls first`, asc(promotionCodes.id))
      .limit(CODES_SHOWN),
    db
      .select({ totalCodes: sql<number>`count(*)`.mapWith(Number) })
      .from(promotionCodes)
      .where(eq(promotionCodes.promotionId, id)),
    statsByPromotion(id),
  ]);
  return { row, terms: toTerms(row), codes, totalCodes, stats: stats.get(id) ?? NO_STATS };
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

/** Live promotions an operator can comp by hand: whole-order rewards only. */
export async function compPresets(): Promise<(PromotionTerms & { id: number })[]> {
  const rows = await db
    .select()
    .from(promotions)
    .where(sql`${promotions.isActive} and ${promotions.archivedAt} is null and ${promotions.reward}->>'type' in ('order_percent', 'order_amount')`)
    .orderBy(asc(promotions.id));
  return rows.map(toTerms);
}
