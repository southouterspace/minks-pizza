/**
 * The pure promotions evaluator: a priced cart plus candidate promotions in,
 * discounts, typed refusals and nudges out. Shared by server and client; no
 * I/O and no English (promotion-copy.ts owns the words).
 */
import { zonedParts } from "./hours";
import { bpsOf } from "./money";
import type { LineModifier } from "./pricing";
import {
  REWARD_SCOPE,
  type DiscountTarget,
  type OrderType,
  type PromotionReward,
  type PromotionTrigger,
  type RewardScope,
  type RewardType,
  type Target,
  type WeeklyWindow,
} from "./promotion-schema";

/** Everything the evaluator reads about a promotion. */
export type PromotionTerms = {
  id: number;
  name: string;
  trigger: PromotionTrigger;
  reward: PromotionReward;
  minSubtotalCents: number;
  orderTypes: OrderType[];
  startsAt: Date | null;
  endsAt: Date | null;
  schedule: WeeklyWindow[] | null;
  newCustomersOnly: boolean;
  perCustomerLimit: number | null;
  totalLimit: number | null;
  stackable: boolean;
  isActive: boolean;
  archivedAt: Date | null;
};

export type MatchedCode = {
  id: number;
  /** Normalized, the matching form. */
  code: string;
  display: string;
  maxUses: number | null;
  uses: number;
};

/**
 * A promotion that might apply: every live automatic promotion, plus each
 * promotion an entered code matched. Usage counts come from the redemption
 * ledger and exclude canceled orders.
 */
export type PromotionCandidate = {
  promotion: PromotionTerms;
  uses: number;
  /** Redemptions by this customer's phone; 0 before a phone is known. */
  customerUses: number;
  code: MatchedCode | null;
};

export type EvalLine = {
  itemId: number;
  categoryId: number;
  modifierIds: number[];
  /** What each choice on the line was charged, so a bundle can include some toppings. */
  modifiers: readonly LineModifier[];
  quantity: number;
  unitPriceCents: number;
};

export type EvaluateInput = {
  lines: EvalLine[];
  orderType: OrderType;
  subtotalCents: number;
  deliveryFeeCents: number;
  now: Date;
  timezone: string;
  /** Normalized phone digits; null until the customer types one. */
  customerKey: string | null;
  /** A non-canceled order already exists for customerKey. */
  customerHasOrdered: boolean;
  /** Normalized, in the order the customer entered them. */
  enteredCodes: string[];
  candidates: PromotionCandidate[];
};

export type AppliedDiscount = {
  promotionId: number;
  codeId: number | null;
  /** The code as the operator wrote it, or null for an automatic deal. */
  code: string | null;
  label: string;
  amountCents: number;
  target: DiscountTarget;
  endsAt: Date | null;
  /** What the checkout re-checks under lock before the order goes in. */
  limits: {
    totalLimit: number | null;
    perCustomerLimit: number | null;
    codeMaxUses: number | null;
    newCustomersOnly: boolean;
  };
};

/** Why a candidate can't apply, as data; promotion-copy.ts owns the words. */
export type Refusal =
  | { kind: "unknown" }
  | { kind: "duplicate" }
  | { kind: "ended" }
  | { kind: "notStarted"; startsAt: Date }
  | { kind: "expired"; endsAt: Date }
  | { kind: "soldOut" }
  | { kind: "perCustomer" }
  | { kind: "newCustomers" }
  | { kind: "schedule"; schedule: WeeklyWindow[] }
  | { kind: "orderType"; only: OrderType }
  | { kind: "short"; shortCents: number }
  | { kind: "noQualifying"; reward: PromotionReward }
  | { kind: "betterDeal"; winners: string[] };

export type Rejection = {
  /** Normalized. */
  code: string;
  /** The code as the operator wrote it, or the normalized code when nothing matched. */
  display: string;
  refusal: Refusal;
};

/** A deal the customer is only `shortCents` of item subtotal away from. */
export type Nudge = {
  promotionId: number;
  shortCents: number;
  /** The code's display form, or null for an automatic deal. */
  code: string | null;
  name: string;
  rewardType: RewardType;
};

export type Evaluation = {
  applied: AppliedDiscount[];
  rejected: Rejection[];
  nudges: Nudge[];
  discountCents: number;
};

/** The customer identity limits are counted against: the phone's last 10 digits. */
export function customerKeyFromPhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : null;
}

// ---------------------------------------------------------------------------
// Rewards over units
// ---------------------------------------------------------------------------

/** One unit of one cart line, with what is left of its price after earlier discounts. */
type Unit = { line: number; remaining: number };

type PriceState = { units: Unit[]; orderTaken: number; delivery: number };

function freshState(input: EvaluateInput): PriceState {
  const units: Unit[] = [];
  input.lines.forEach((l, line) => {
    for (let i = 0; i < l.quantity; i++) units.push({ line, remaining: l.unitPriceCents });
  });
  return { units, orderTaken: 0, delivery: input.deliveryFeeCents };
}

function itemPool(s: PriceState): number {
  return s.units.reduce((sum, u) => sum + u.remaining, 0) - s.orderTaken;
}

export function lineQualifies(line: EvalLine, t: Target): boolean {
  return (
    (t.categoryIds.length === 0 || t.categoryIds.includes(line.categoryId)) &&
    (t.itemIds.length === 0 || t.itemIds.includes(line.itemId)) &&
    (t.modifierIds.length === 0 || line.modifierIds.some((m) => t.modifierIds.includes(m)))
  );
}

/**
 * Discount each qualifying unit by `perUnit(remaining)`, choosing the units
 * that save the most when `maxUnits` caps them. Never takes a unit below 0.
 */
function discountUnits(
  s: PriceState,
  lines: EvalLine[],
  target: Target,
  maxUnits: number | null,
  perUnit: (remaining: number) => number,
): number {
  const picks = s.units
    .filter((u) => lineQualifies(lines[u.line], target))
    .map((u) => ({ u, off: Math.min(u.remaining, Math.max(0, perUnit(u.remaining))) }))
    .filter((p) => p.off > 0)
    .sort((a, b) => b.off - a.off)
    .slice(0, maxUnits ?? undefined);
  for (const p of picks) p.u.remaining -= p.off;
  return picks.reduce((sum, p) => sum + p.off, 0);
}

/**
 * Buy X get Y. Each application takes the cheapest `get` units still free,
 * then the dearest `buy` units that aren't among them, so the discounted
 * units are always the cheapest qualifying ones and no unit is both a buy
 * and a get. Stops when a full set can't be formed.
 */
function applyBogo(
  s: PriceState,
  lines: EvalLine[],
  reward: Extract<PromotionReward, { type: "bogo" }>,
): number {
  const used = new Set<Unit>();
  const byPrice = (dir: 1 | -1) => (a: Unit, b: Unit) => dir * (a.remaining - b.remaining);
  let total = 0;
  for (let n = 0; reward.maxApplications === null || n < reward.maxApplications; n++) {
    const gets = s.units
      .filter((u) => !used.has(u) && lineQualifies(lines[u.line], reward.get.target))
      .sort(byPrice(1))
      .slice(0, reward.get.quantity);
    if (gets.length < reward.get.quantity) break;
    const buys = s.units
      .filter((u) => !used.has(u) && !gets.includes(u) && lineQualifies(lines[u.line], reward.buy.target))
      .sort(byPrice(-1))
      .slice(0, reward.buy.quantity);
    if (buys.length < reward.buy.quantity) break;
    for (const u of [...gets, ...buys]) used.add(u);
    for (const u of gets) {
      const off = Math.min(u.remaining, bpsOf(u.remaining, reward.get.percentBps));
      u.remaining -= off;
      total += off;
    }
  }
  return total;
}

type Bundle = Extract<PromotionReward, { type: "bundle" }>;

/**
 * A unit's price under a bundle: the deal price plus its crust charge (a
 * gluten-free upgrade is never part of the deal) and every topping charge
 * past the included ones, dearest included first.
 */
function bundleUnitPrice(line: EvalLine, reward: Bundle): number {
  const sum = (charges: number[]) => charges.reduce((total, c) => total + c, 0);
  const crust = sum(line.modifiers.filter((m) => m.role === "crust").map((m) => m.priceDeltaCents));
  if (reward.includedToppings === null) return reward.priceCents + crust;
  const charges = line.modifiers
    .filter((m) => m.kind === "placed" && m.role === "topping" && m.amount !== "none")
    .map((m) => m.priceDeltaCents)
    .sort((a, b) => b - a);
  return reward.priceCents + crust + sum(charges.slice(reward.includedToppings));
}

/**
 * N items for a price each. Sets are priced as a whole, so a unit already
 * under the deal price still counts toward one; units that save the most go
 * into the first sets, and a set that saves nothing ends the search.
 */
function applyBundle(s: PriceState, lines: EvalLine[], reward: Bundle): number {
  const pool = s.units
    .filter((u) => lineQualifies(lines[u.line], reward.target))
    .map((u) => ({ u, saving: u.remaining - bundleUnitPrice(lines[u.line], reward) }))
    .sort((a, b) => b.saving - a.saving);
  let total = 0;
  for (let n = 0; reward.maxApplications === null || n < reward.maxApplications; n++) {
    const set = pool.slice(n * reward.quantity, (n + 1) * reward.quantity);
    if (set.length < reward.quantity) break;
    let left = set.reduce((sum, p) => sum + p.saving, 0);
    if (left <= 0) break;
    total += left;
    for (const p of set) {
      const off = Math.min(Math.max(0, p.saving), left);
      p.u.remaining -= off;
      left -= off;
    }
  }
  return total;
}

/** Applies a reward to `s` in place and returns the cents it took off. */
function applyReward(reward: PromotionReward, s: PriceState, lines: EvalLine[]): number {
  switch (reward.type) {
    case "order_percent": {
      const pool = itemPool(s);
      const off = Math.min(pool, bpsOf(pool, reward.percentBps), reward.maxDiscountCents ?? Infinity);
      s.orderTaken += off;
      return off;
    }
    case "order_amount": {
      const off = Math.min(itemPool(s), reward.amountCents);
      s.orderTaken += off;
      return off;
    }
    case "item_percent":
      return discountUnits(s, lines, reward.target, reward.maxUnits, (r) => bpsOf(r, reward.percentBps));
    case "item_amount":
      return discountUnits(s, lines, reward.target, reward.maxUnits, () => reward.amountCents);
    case "item_price":
      return discountUnits(s, lines, reward.target, reward.maxUnits, (r) => r - reward.priceCents);
    case "bogo":
      return applyBogo(s, lines, reward);
    case "bundle":
      return applyBundle(s, lines, reward);
    case "free_delivery": {
      const off = s.delivery;
      s.delivery = 0;
      return off;
    }
    default: {
      const never: never = reward;
      throw new Error(`Unknown reward ${JSON.stringify(never)}`);
    }
  }
}

export function rewardTarget(reward: PromotionReward): DiscountTarget {
  return REWARD_SCOPE[reward.type] === "delivery" ? "delivery" : "items";
}

/** Item-level rewards go first so order-level ones discount what is left. */
const STAGE: Record<RewardScope, number> = { item: 0, order: 1, delivery: 2 };
const stage = (reward: PromotionReward) => STAGE[REWARD_SCOPE[reward.type]];

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Inside any window, on the store's clock. Overnight windows belong to the day they start. */
export function inSchedule(schedule: WeeklyWindow[] | null, now: Date, timeZone: string): boolean {
  if (!schedule || schedule.length === 0) return true;
  const { day, minutes } = zonedParts(now, timeZone);
  const yesterday = (day + 6) % 7;
  return schedule.some((w) => {
    const start = minutesOf(w.start);
    const end = minutesOf(w.end);
    if (start < end) return w.days.includes(day) && minutes >= start && minutes < end;
    return (w.days.includes(day) && minutes >= start) || (w.days.includes(yesterday) && minutes < end);
  });
}

/**
 * The first reason this candidate can't apply, or null. Hard stops come
 * first (ended, used up, already used) so a customer is never told to add
 * $4 for an offer that still wouldn't work; the fixable ones follow.
 */
function firstRefusal(c: PromotionCandidate, input: EvaluateInput): Refusal | null {
  const p = c.promotion;
  const { now, timezone } = input;
  if (!p.isActive || p.archivedAt) return { kind: "ended" };
  if (p.startsAt && p.startsAt > now) return { kind: "notStarted", startsAt: p.startsAt };
  if (p.endsAt && p.endsAt <= now) return { kind: "expired", endsAt: p.endsAt };
  if ((p.totalLimit !== null && c.uses >= p.totalLimit) || (c.code?.maxUses != null && c.code.uses >= c.code.maxUses)) {
    return { kind: "soldOut" };
  }
  if (input.customerKey) {
    if (p.perCustomerLimit !== null && c.customerUses >= p.perCustomerLimit) return { kind: "perCustomer" };
    if (p.newCustomersOnly && input.customerHasOrdered) return { kind: "newCustomers" };
  }
  if (!inSchedule(p.schedule, now, timezone)) return { kind: "schedule", schedule: p.schedule ?? [] };
  if (!p.orderTypes.includes(input.orderType)) return { kind: "orderType", only: input.orderType === "pickup" ? "delivery" : "pickup" };
  const short = p.minSubtotalCents - input.subtotalCents;
  if (short > 0) return { kind: "short", shortCents: short };
  if (applyReward(p.reward, freshState(input), input.lines) === 0) return { kind: "noQualifying", reward: p.reward };
  return null;
}

/** A nudge when the minimum subtotal is the only thing between the customer and the deal. */
function nudgeFor(c: PromotionCandidate, refusal: Refusal, input: EvaluateInput): Nudge | null {
  if (refusal.kind !== "short") return null;
  if (firstRefusal(c, { ...input, subtotalCents: c.promotion.minSubtotalCents }) !== null) return null;
  return {
    promotionId: c.promotion.id,
    shortCents: refusal.shortCents,
    code: c.code?.display ?? null,
    name: c.promotion.name,
    rewardType: c.promotion.reward.type,
  };
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/** Applies candidates in stage order to one fresh price state; zero-value ones drop out. */
function applyAll(chosen: PromotionCandidate[], input: EvaluateInput): AppliedDiscount[] {
  const s = freshState(input);
  return [...chosen]
    .sort((a, b) => stage(a.promotion.reward) - stage(b.promotion.reward) || a.promotion.id - b.promotion.id)
    .map((c) => ({
      promotionId: c.promotion.id,
      codeId: c.code?.id ?? null,
      code: c.code?.display ?? null,
      label: c.promotion.name,
      amountCents: applyReward(c.promotion.reward, s, input.lines),
      target: rewardTarget(c.promotion.reward),
      endsAt: c.promotion.endsAt,
      limits: {
        totalLimit: c.promotion.totalLimit,
        perCustomerLimit: c.promotion.perCustomerLimit,
        codeMaxUses: c.code?.maxUses ?? null,
        newCustomersOnly: c.promotion.newCustomersOnly,
      },
    }))
    .filter((a) => a.amountCents > 0);
}

const sum = (applied: AppliedDiscount[]) => applied.reduce((n, a) => n + a.amountCents, 0);

/**
 * The best deal for the customer: each eligible non-stackable promotion on
 * its own, or every eligible stackable one together, whichever saves the
 * most. A tie goes to the option using more of the customer's codes.
 * Every entered code ends up applied or rejected with a reason.
 */
export function evaluatePromotions(input: EvaluateInput): Evaluation {
  const rejected: Rejection[] = [];
  const nudges: Nudge[] = [];
  const eligible: PromotionCandidate[] = [];
  const seen = new Set<number>();

  const byCode = new Map(
    input.candidates.flatMap((c) => (c.code ? [[c.code.code, c] as const] : [])),
  );
  const entries = [
    ...input.candidates
      .filter((c) => c.code === null && c.promotion.trigger === "automatic")
      .map((candidate) => ({ code: null, candidate })),
    ...[...new Set(input.enteredCodes)].map((code) => ({ code, candidate: byCode.get(code) })),
  ];

  for (const { code, candidate: c } of entries) {
    const refusal: Refusal | null = !c
      ? { kind: "unknown" }
      : seen.has(c.promotion.id)
        ? { kind: "duplicate" }
        : firstRefusal(c, input);
    if (c) seen.add(c.promotion.id);
    if (!refusal) {
      eligible.push(c!);
      continue;
    }
    if (code !== null) rejected.push({ code, display: c?.code?.display ?? code, refusal });
    const nudge = c && nudgeFor(c, refusal, input);
    if (nudge) nudges.push(nudge);
  }

  const stackable = eligible.filter((c) => c.promotion.stackable);
  const options = [
    ...eligible.filter((c) => !c.promotion.stackable).map((c) => [c]),
    ...(stackable.length ? [stackable] : []),
  ].map((chosen) => {
    const applied = applyAll(chosen, input);
    return { applied, total: sum(applied), codes: applied.filter((a) => a.codeId !== null).length };
  });

  const best = options.reduce<(typeof options)[number] | null>(
    (top, o) => (!top || o.total > top.total || (o.total === top.total && o.codes > top.codes) ? o : top),
    null,
  );
  const applied = best?.applied ?? [];
  const winners = applied.map((a) => a.label);
  for (const c of eligible) {
    if (c.code && !applied.some((a) => a.promotionId === c.promotion.id)) {
      rejected.push({ code: c.code.code, display: c.code.display, refusal: { kind: "betterDeal", winners } });
    }
  }

  return { applied, rejected, nudges, discountCents: sum(applied) };
}

/** Totals with discounts: tax on items after item discounts, the fee after delivery discounts. */
export function discountedTotals(args: {
  subtotalCents: number;
  deliveryFeeCents: number;
  tipCents: number;
  taxRateBps: number;
  discounts: { amountCents: number; target: DiscountTarget }[];
}) {
  const itemDiscount = args.discounts.filter((d) => d.target === "items").reduce((n, d) => n + d.amountCents, 0);
  const deliveryDiscount = args.discounts.filter((d) => d.target === "delivery").reduce((n, d) => n + d.amountCents, 0);
  const taxCents = bpsOf(Math.max(0, args.subtotalCents - itemDiscount), args.taxRateBps);
  const discountCents = itemDiscount + deliveryDiscount;
  return {
    discountCents,
    taxCents,
    totalCents: args.subtotalCents - discountCents + taxCents + args.deliveryFeeCents + args.tipCents,
  };
}

// ---------------------------------------------------------------------------
// Operator status
// ---------------------------------------------------------------------------

export const PROMOTION_STATUSES = ["active", "scheduled", "expired", "paused", "used_up", "archived"] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

/**
 * Derived from the data, never stored. firstRefusal checks the same facts
 * in the customer's order, so the two can differ: a deal both used up and
 * not yet started reads "Used up" here and "Starts Oct 10" at checkout.
 */
export function promotionStatus(
  p: Pick<PromotionTerms, "isActive" | "archivedAt" | "startsAt" | "endsAt" | "totalLimit">,
  usage: { uses: number },
  now: Date,
): PromotionStatus {
  if (p.archivedAt) return "archived";
  if (!p.isActive) return "paused";
  if (p.endsAt && p.endsAt <= now) return "expired";
  if (p.totalLimit !== null && usage.uses >= p.totalLimit) return "used_up";
  if (p.startsAt && p.startsAt > now) return "scheduled";
  return "active";
}
