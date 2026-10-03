import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  categories,
  db,
  menuItems,
  modifiers,
  orderDiscounts,
  orders,
  promotionCodes,
  promotions,
} from "@/db";
import {
  normalizeCode,
  promotionRewardSchema,
  type PromotionCandidate,
  type PromotionTerms,
  type TargetNames,
} from "@/lib/promotions";

export type PromotionRow = typeof promotions.$inferSelect;

/** A row as the evaluator reads it; the reward is re-parsed so a bad row fails loudly here. */
export function toTerms(row: PromotionRow): PromotionTerms {
  return { ...row, reward: promotionRewardSchema.parse(row.reward) };
}

/** Digits-only phone, last ten, in SQL: the same key customerKeyFromPhone makes. */
export const phoneKeySql = sql`right(regexp_replace(${orders.customerPhone}, '\\D', '', 'g'), 10)`;

const kept = ne(orders.status, "canceled");

/** Redemptions of each promotion over non-canceled orders, overall and for one customer. */
export async function promotionUsage(promotionIds: number[], customerKey: string | null) {
  if (promotionIds.length === 0) return new Map<number, { uses: number; customerUses: number }>();
  const rows = await db
    .select({
      promotionId: orderDiscounts.promotionId,
      uses: sql<number>`count(*)`.mapWith(Number),
      customerUses: sql<number>`count(*) filter (where ${orderDiscounts.customerKey} = ${customerKey ?? ""})`.mapWith(Number),
    })
    .from(orderDiscounts)
    .innerJoin(orders, eq(orders.id, orderDiscounts.orderId))
    .where(and(inArray(orderDiscounts.promotionId, promotionIds), kept))
    .groupBy(orderDiscounts.promotionId);
  return new Map(rows.map((r) => [r.promotionId!, { uses: r.uses, customerUses: r.customerUses }]));
}

async function codeUsage(codeIds: number[]) {
  if (codeIds.length === 0) return new Map<number, number>();
  const rows = await db
    .select({ codeId: orderDiscounts.codeId, uses: sql<number>`count(*)`.mapWith(Number) })
    .from(orderDiscounts)
    .innerJoin(orders, eq(orders.id, orderDiscounts.orderId))
    .where(and(inArray(orderDiscounts.codeId, codeIds), kept))
    .groupBy(orderDiscounts.codeId);
  return new Map(rows.map((r) => [r.codeId!, r.uses]));
}

async function hasOrdered(customerKey: string | null): Promise<boolean> {
  if (!customerKey) return false;
  const [row] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(kept, sql`${phoneKeySql} = ${customerKey}`))
    .limit(1);
  return Boolean(row);
}

export async function targetNames(): Promise<TargetNames> {
  const [cats, items, mods] = await Promise.all([
    db.select({ id: categories.id, name: categories.name }).from(categories),
    db.select({ id: menuItems.id, name: menuItems.name }).from(menuItems),
    db.select({ id: modifiers.id, name: modifiers.name }).from(modifiers),
  ]);
  const record = (rows: { id: number; name: string }[]) => Object.fromEntries(rows.map((r) => [r.id, r.name]));
  return { categories: record(cats), items: record(items), modifiers: record(mods) };
}

/**
 * Every live automatic promotion plus whatever the entered codes match
 * (paused or archived ones too, so the customer hears "This offer has
 * ended." rather than "We don't recognize that code."), with usage.
 */
export async function loadCandidates(enteredCodes: string[], customerKey: string | null) {
  const normalized = [...new Set(enteredCodes.map(normalizeCode).filter(Boolean))];
  const [automatic, matched, customerHasOrdered, names] = await Promise.all([
    db
      .select()
      .from(promotions)
      .where(and(eq(promotions.trigger, "automatic"), eq(promotions.isActive, true), isNull(promotions.archivedAt))),
    normalized.length
      ? db
          .select({ code: promotionCodes, promotion: promotions })
          .from(promotionCodes)
          .innerJoin(promotions, eq(promotions.id, promotionCodes.promotionId))
          .where(and(inArray(promotionCodes.code, normalized), eq(promotions.trigger, "code")))
      : Promise.resolve([]),
    hasOrdered(customerKey),
    targetNames(),
  ]);

  const promotionIds = [...new Set([...automatic.map((p) => p.id), ...matched.map((m) => m.promotion.id)])];
  const [usage, codeUses] = await Promise.all([
    promotionUsage(promotionIds, customerKey),
    codeUsage(matched.map((m) => m.code.id)),
  ]);
  const usageOf = (id: number) => usage.get(id) ?? { uses: 0, customerUses: 0 };

  const candidates: PromotionCandidate[] = [
    ...automatic.map((p) => ({ promotion: toTerms(p), ...usageOf(p.id), code: null })),
    ...matched.map(({ code, promotion }) => ({
      promotion: toTerms(promotion),
      ...usageOf(promotion.id),
      code: {
        id: code.id,
        code: code.code,
        display: code.display,
        maxUses: code.maxUses,
        uses: codeUses.get(code.id) ?? 0,
      },
    })),
  ];
  return { candidates, enteredCodes: normalized, customerHasOrdered, names };
}
