import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { categories, db, menuItems, modifiers, orders, promotionCodes, promotions } from "@/db";
import { normalizeCode } from "@/lib/promo-code";
import { describeOffer, formatLastDay, type TargetNames } from "@/lib/promotion-copy";
import type { PromotionCandidate, PromotionTerms } from "@/lib/promotion-engine";
import { promotionRewardSchema } from "@/lib/promotion-schema";
import { codeUsage, promotionUsage } from "@/lib/promotion-usage";

export type PromotionRow = typeof promotions.$inferSelect;

/** A row as the evaluator reads it; the reward is re-parsed so a bad row fails loudly here. */
export function toTerms(row: PromotionRow): PromotionTerms {
  // Deals are offered online only; dine-in is rung in at the counter.
  const orderTypes = row.orderTypes.filter((t): t is "pickup" | "delivery" => t !== "dine_in");
  return { ...row, orderTypes, reward: promotionRewardSchema.parse(row.reward) };
}

async function hasOrdered(customerKey: string | null): Promise<boolean> {
  if (!customerKey) return false;
  const [row] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(ne(orders.status, "canceled"), eq(orders.customerKey, customerKey)))
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

export type AdvertisedDeal = {
  id: number;
  name: string;
  terms: string;
  /** A shared code to show and copy; null for automatic deals and private batches. */
  code: string | null;
  ends: string | null;
};

/** Advertised promotions running now and not used up, for the storefront strip. */
export async function getAdvertisedDeals(now: Date, timezone: string): Promise<AdvertisedDeal[]> {
  const rows = await db
    .select()
    .from(promotions)
    .where(
      and(
        eq(promotions.advertised, true),
        eq(promotions.isActive, true),
        isNull(promotions.archivedAt),
        sql`(${promotions.startsAt} is null or ${promotions.startsAt} <= ${now.toISOString()}::timestamptz)`,
        sql`(${promotions.endsAt} is null or ${promotions.endsAt} > ${now.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(promotions.id);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [usage, shared, names] = await Promise.all([
    promotionUsage(ids, null),
    db
      .select({ promotionId: promotionCodes.promotionId, display: promotionCodes.display })
      .from(promotionCodes)
      .where(and(inArray(promotionCodes.promotionId, ids), isNull(promotionCodes.maxUses)))
      .orderBy(promotionCodes.id),
    targetNames(),
  ]);
  return rows
    .filter((r) => r.totalLimit === null || (usage.get(r.id)?.uses ?? 0) < r.totalLimit)
    .map((r) => {
      const terms = toTerms(r);
      const code = shared.find((c) => c.promotionId === r.id)?.display ?? null;
      return {
        id: r.id,
        name: r.name,
        terms: r.description?.trim() || describeOffer({ ...terms, endsAt: null }, { timezone, code, names }),
        code,
        ends: r.endsAt ? `Ends ${formatLastDay(r.endsAt, timezone)}` : null,
      };
    });
}
