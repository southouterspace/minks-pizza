/**
 * Loyalty program rules. Pure: no database, no server-only, so the
 * storefront, the admin and the tests share one definition of every rule.
 */
import { z } from "zod";

export const LEDGER_KINDS = [
  "earn",
  "redeem",
  "redeem_refund",
  "signup_bonus",
  "birthday",
  "referral",
  "adjust",
  "expire",
] as const;

export type LedgerKind = (typeof LEDGER_KINDS)[number];

/**
 * Per kind: whether positive points count toward lifetime earned, and how the
 * entry reads in a member's history.
 */
export const LEDGER_KIND_RULES: Record<LedgerKind, { lifetime: boolean; label: string }> = {
  earn: { lifetime: true, label: "Points earned" },
  redeem: { lifetime: false, label: "Reward redeemed" },
  redeem_refund: { lifetime: false, label: "Points returned" },
  signup_bonus: { lifetime: true, label: "Welcome bonus" },
  birthday: { lifetime: true, label: "Birthday bonus" },
  referral: { lifetime: true, label: "Referral bonus" },
  adjust: { lifetime: true, label: "Adjusted by the store" },
  expire: { lifetime: false, label: "Points expired" },
};

/** The welcome bonus waits for a first completed order of at least this net. */
export const SIGNUP_MIN_NET_CENTS = 1500;

/** Referrer bonuses paid per member in any rolling 365 days. */
export const REFERRER_BONUS_YEARLY_CAP = 10;

export type LoyaltyTier = { name: string; minPoints: number; multiplierBps: number };

/** One tier means no tiers: the storefront hides tier UI until there are two. */
export const DEFAULT_TIERS: LoyaltyTier[] = [{ name: "Member", minPoints: 0, multiplierBps: 10_000 }];

export const tiersSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1, "Every tier needs a name").max(40),
      minPoints: z.number().int().min(0),
      multiplierBps: z.number().int().min(10_000, "Multipliers start at 1x").max(100_000),
    }),
  )
  .min(1, "Add at least one tier")
  .max(8)
  .refine((t) => t[0].minPoints === 0, "The first tier must start at 0 points")
  .refine(
    (t) => t.every((tier, i) => i === 0 || tier.minPoints > t[i - 1].minPoints),
    "Each tier must need more points than the one before it",
  );

/**
 * What a reward does at checkout. A free item names a set of categories
 * because one menu concept (pizza) is often split across several
 * (Specialty, Build Your Own).
 */
export const rewardEffectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("amount_off"),
    amountOffCents: z.number().int().positive().max(100_000),
  }),
  z.object({
    kind: z.literal("free_item"),
    categoryIds: z.array(z.number().int().positive()).min(1),
    maxValueCents: z.number().int().positive().max(100_000),
  }),
]);

export type RewardEffect = z.infer<typeof rewardEffectSchema>;

/** Where an order's points stand, as a member sees it. */
export function orderPointsStatus(status: string): "Pending" | "Posted" | "Reversed" {
  if (status === "completed") return "Posted";
  if (status === "canceled") return "Reversed";
  return "Pending";
}

// ---------------------------------------------------------------------------
// Phone identity
// ---------------------------------------------------------------------------

/** US phone → 10 digits, or null when it can't be one. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}

export function formatPhone(phone: string): string {
  if (!/^\d{10}$/.test(phone)) return phone;
  return `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`;
}

// ---------------------------------------------------------------------------
// Earning
// ---------------------------------------------------------------------------

/**
 * Points for an order. `netCents` is the food subtotal after any reward
 * discount: tax, tip and delivery fee never earn. Integer math throughout so
 * the promise at checkout and the posting at completion always agree.
 */
export function earnPoints({
  netCents,
  pointsPerDollar,
  tierMultiplierBps,
  promoMultiplierBps,
}: {
  netCents: number;
  pointsPerDollar: number;
  tierMultiplierBps: number;
  promoMultiplierBps: number;
}): number {
  if (netCents <= 0) return 0;
  const raw =
    (BigInt(netCents) *
      BigInt(pointsPerDollar) *
      BigInt(tierMultiplierBps) *
      BigInt(promoMultiplierBps)) /
    BigInt(100 * 10_000 * 10_000);
  return Number(raw);
}

export function tierFor(qualifyingPoints: number, tiers: LoyaltyTier[]): LoyaltyTier {
  const sorted = tiers.toSorted((a, b) => a.minPoints - b.minPoints);
  return sorted.findLast((t) => t.minPoints <= qualifyingPoints) ?? sorted[0];
}

export type TierProgress = {
  tier: LoyaltyTier;
  next: LoyaltyTier | null;
  pointsToNext: number | null;
  /** 0–1 through the current tier toward the next; 1 at the top tier. */
  fraction: number;
};

export function tierProgress(qualifyingPoints: number, tiers: LoyaltyTier[]): TierProgress {
  const tier = tierFor(qualifyingPoints, tiers);
  const next =
    tiers
      .toSorted((a, b) => a.minPoints - b.minPoints)
      .find((t) => t.minPoints > tier.minPoints) ?? null;
  if (!next) return { tier, next: null, pointsToNext: null, fraction: 1 };
  const span = next.minPoints - tier.minPoints;
  return {
    tier,
    next,
    pointsToNext: next.minPoints - qualifyingPoints,
    fraction: Math.min(1, Math.max(0, (qualifyingPoints - tier.minPoints) / span)),
  };
}

/** "2x", "1.25x" */
export function formatMultiplier(bps: number): string {
  return `${Number((bps / 10_000).toFixed(2))}x`;
}

// ---------------------------------------------------------------------------
// Store-local calendar
// ---------------------------------------------------------------------------

export type LocalDate = { iso: string; year: number; month: number; day: number; weekday: number };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localDate(at: Date, timezone: string): LocalDate {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    iso: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

export type PromotionRule = {
  name: string;
  multiplierBps: number;
  daysOfWeek: number[];
  startsOn: string | null;
  endsOn: string | null;
  isActive: boolean;
};

/** The richest promotion running on the store-local date of `at`, if any. */
export function activePromotion<P extends PromotionRule>(
  promos: P[],
  at: Date,
  timezone: string,
): P | null {
  const today = localDate(at, timezone);
  let best: P | null = null;
  for (const p of promos) {
    if (!p.isActive) continue;
    if (p.daysOfWeek.length > 0 && !p.daysOfWeek.includes(today.weekday)) continue;
    if (p.startsOn && today.iso < p.startsOn) continue;
    if (p.endsOn && today.iso > p.endsOn) continue;
    if (!best || p.multiplierBps > best.multiplierBps) best = p;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

export type DiscountLine = { categoryId: number; unitPriceCents: number; quantity: number };

export type DiscountResult =
  | { ok: true; discountCents: number }
  | { ok: false; reason: "no_matching_item" };

export function rewardDiscount(effect: RewardEffect, lines: DiscountLine[]): DiscountResult {
  const subtotal = lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
  switch (effect.kind) {
    case "amount_off":
      return { ok: true, discountCents: Math.min(effect.amountOffCents, subtotal) };
    case "free_item": {
      const prices = lines
        .filter((l) => effect.categoryIds.includes(l.categoryId))
        .map((l) => l.unitPriceCents);
      if (prices.length === 0) return { ok: false, reason: "no_matching_item" };
      return {
        ok: true,
        discountCents: Math.min(Math.max(...prices), effect.maxValueCents, subtotal),
      };
    }
  }
}

/** The dollar value a reward stands for: the amount off, or the free item's cap. */
export function rewardValueCents(effect: RewardEffect): number {
  return effect.kind === "amount_off" ? effect.amountOffCents : effect.maxValueCents;
}

// ---------------------------------------------------------------------------
// Price protection
// ---------------------------------------------------------------------------

/** How long the old price holds after an operator raises a reward's cost. */
export const PRICE_PROTECTION_DAYS = 60;

export type RewardPricing = {
  pointsCost: number;
  previousPointsCost: number | null;
  priceProtectedUntil: Date | null;
};

export type RewardPrice = {
  /** What a customer pays today. */
  cost: number;
  /** A scheduled increase still inside its protection window. */
  increase: { cost: number; on: Date } | null;
};

export function rewardPrice(r: RewardPricing, now: Date): RewardPrice {
  const protectedPrice =
    r.previousPointsCost !== null && r.priceProtectedUntil !== null && now < r.priceProtectedUntil
      ? r.previousPointsCost
      : null;
  if (protectedPrice === null || protectedPrice >= r.pointsCost) {
    return { cost: Math.min(r.pointsCost, protectedPrice ?? Infinity), increase: null };
  }
  return { cost: protectedPrice, increase: { cost: r.pointsCost, on: r.priceProtectedUntil! } };
}

export function formatPriceIncrease(
  increase: { cost: number; on: Date },
  timezone: string,
): string {
  const on = increase.on.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: timezone });
  return `Price going up to ${increase.cost.toLocaleString()} on ${on}`;
}

/**
 * An operator's new cost. A raise keeps today's price for 60 days; a cut, or
 * a change that stays at or below today's price, applies at once.
 */
export function repriceReward(current: RewardPricing, newCost: number, now: Date): RewardPricing {
  const today = rewardPrice(current, now).cost;
  if (newCost <= today) {
    return { pointsCost: newCost, previousPointsCost: null, priceProtectedUntil: null };
  }
  return {
    pointsCost: newCost,
    previousPointsCost: today,
    priceProtectedUntil: new Date(now.getTime() + PRICE_PROTECTION_DAYS * 24 * 60 * 60 * 1000),
  };
}

// ---------------------------------------------------------------------------
// Lazy grants
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * True during the member's birthday month for a member who ordered in the
 * last year, unless the birthday was set in the last 30 days (stops setting
 * it to this month to collect the bonus).
 */
export function birthdayGrantDue(
  member: {
    birthMonth: number | null;
    birthdaySetAt: Date | null;
    lastCompletedOrderAt: Date | null;
  },
  now: Date,
  timezone: string,
): boolean {
  const { birthMonth, birthdaySetAt, lastCompletedOrderAt } = member;
  if (birthMonth === null || birthdaySetAt === null || lastCompletedOrderAt === null) return false;
  if (now.getTime() - birthdaySetAt.getTime() < 30 * DAY_MS) return false;
  if (now.getTime() - lastCompletedOrderAt.getTime() > 365 * DAY_MS) return false;
  return localDate(now, timezone).month === birthMonth;
}

/**
 * The month and year a birthday bonus can next arrive: the first birthday
 * month that starts after now and at least 30 days after the birthday was set
 * (or the current month, when both already hold).
 */
export function nextBirthdayGrant(
  member: { birthMonth: number; birthdaySetAt: Date },
  now: Date,
  timezone: string,
): { month: number; year: number } {
  const earliest = new Date(Math.max(now.getTime(), member.birthdaySetAt.getTime() + 30 * DAY_MS));
  const start = localDate(earliest, timezone);
  if (start.month === member.birthMonth) return { month: start.month, year: start.year };
  const monthsAhead = (member.birthMonth - start.month + 12) % 12;
  return {
    month: member.birthMonth,
    year: start.year + (start.month + monthsAhead > 12 ? 1 : 0),
  };
}

/**
 * When a balance expires without another completed order; null when it never
 * will. `lastActivityAt` is the last completed order (or enrollment).
 */
export function pointsSafeUntil(
  member: { pointsBalance: number; lastActivityAt: Date },
  months: number | null,
): Date | null {
  if (months === null || member.pointsBalance <= 0) return null;
  const until = new Date(member.lastActivityAt);
  until.setUTCMonth(until.getUTCMonth() + months);
  return until;
}

export function expiryDue(
  member: { pointsBalance: number; lastActivityAt: Date },
  now: Date,
  months: number | null,
): boolean {
  const until = pointsSafeUntil(member, months);
  return until !== null && until <= now;
}

/** Operators can undo an expiry for this long. */
export const EXPIRY_RESTORE_DAYS = 30;
