/**
 * Promotions: the reward union, the pure evaluator that turns a priced cart
 * plus candidate promotions into discounts, and the words customers and
 * operators read about them. Shared by server and client; no I/O.
 *
 * Money is integer cents, percentages are basis points (2000 = 20%).
 */
import { z } from "zod";
import { DAY_NAMES, formatTime, zonedParts } from "./hours";
import { formatCents } from "./money";
import { normalizeCode } from "./promo-code";

export const PROMOTION_TRIGGERS = ["automatic", "code"] as const;
export type PromotionTrigger = (typeof PROMOTION_TRIGGERS)[number];

export const ORDER_TYPES = ["pickup", "delivery"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const DISCOUNT_TARGETS = ["items", "delivery"] as const;
export type DiscountTarget = (typeof DISCOUNT_TARGETS)[number];

export const DISCOUNT_SOURCES = ["promotion", "comp"] as const;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const id = z.number().int().positive();
const cents = z.number().int().min(1).max(1_000_000);
const percentBps = z.number().int().min(100, "Percent must be 1–100").max(10_000, "Percent must be 1–100");
const units = z.number().int().min(1).max(100).nullable();

/**
 * A line qualifies when (categoryIds empty or its category is listed) and
 * (itemIds empty or its item is listed) and (modifierIds empty or it carries
 * one of them, e.g. the "Large" size). All empty means any item.
 */
export const targetSchema = z.object({
  categoryIds: z.array(id).max(100),
  itemIds: z.array(id).max(500),
  modifierIds: z.array(id).max(100),
});
export type Target = z.infer<typeof targetSchema>;

export const ANY_ITEM: Target = { categoryIds: [], itemIds: [], modifierIds: [] };

export const promotionRewardSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("order_percent"), percentBps, maxDiscountCents: cents.nullable() }),
  z.object({ type: z.literal("order_amount"), amountCents: cents }),
  z.object({ type: z.literal("item_percent"), target: targetSchema, percentBps, maxUnits: units }),
  z.object({ type: z.literal("item_amount"), target: targetSchema, amountCents: cents, maxUnits: units }),
  z.object({
    type: z.literal("item_price"),
    target: targetSchema,
    priceCents: z.number().int().min(0).max(1_000_000),
    maxUnits: units,
  }),
  z.object({
    type: z.literal("bogo"),
    buy: z.object({ target: targetSchema, quantity: z.number().int().min(1).max(20) }),
    get: z.object({ target: targetSchema, quantity: z.number().int().min(1).max(20), percentBps }),
    maxApplications: units,
  }),
  z.object({ type: z.literal("free_delivery") }),
]);
export type PromotionReward = z.infer<typeof promotionRewardSchema>;
export type RewardType = PromotionReward["type"];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const weeklyWindowSchema = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).min(1, "Pick at least one day").max(7),
    start: z.string().regex(HHMM),
    end: z.string().regex(HHMM),
  })
  .refine((w) => w.start !== w.end, "A time window needs different start and end times");
/** `days`: 0 = Sunday. An end at or before the start runs past midnight. */
export type WeeklyWindow = z.infer<typeof weeklyWindowSchema>;

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
  quantity: number;
  unitPriceCents: number;
};

/** Display names for target ids, for "Add a Large 14" Cheese Pizza to use this". */
export type TargetNames = {
  categories: Record<number, string>;
  items: Record<number, string>;
  modifiers: Record<number, string>;
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
  names?: TargetNames;
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
};

export type Rejection = { code: string; reason: string };
export type Nudge = { promotionId: number; message: string };

export type Evaluation = {
  applied: AppliedDiscount[];
  rejected: Rejection[];
  nudges: Nudge[];
  discountCents: number;
};

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export { normalizeCode };

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

/** Half-up rounding of a basis-point share, in integers so no float drift. */
function bpsOf(amount: number, bps: number): number {
  return Math.floor((amount * bps + 5_000) / 10_000);
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
  return reward.type === "free_delivery" ? "delivery" : "items";
}

/** Item-level rewards go first so order-level ones discount what is left. */
function stage(reward: PromotionReward): number {
  switch (reward.type) {
    case "item_percent":
    case "item_amount":
    case "item_price":
    case "bogo":
      return 0;
    case "order_percent":
    case "order_amount":
      return 1;
    case "free_delivery":
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** "Oct 10" on the store's calendar. */
export function formatDay(d: Date, timeZone: string): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
}

/** The last day an offer runs: endsAt is the exclusive instant it stops. */
export function formatLastDay(endsAt: Date, timeZone: string): string {
  return formatDay(new Date(endsAt.getTime() - 1), timeZone);
}

const SHORT_DAYS = DAY_NAMES.map((d) => d.slice(0, 3));

function describeDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return "Daily";
  const runs: number[][] = [];
  for (const d of sorted) {
    const run = runs.at(-1);
    if (run && run.at(-1) === d - 1) run.push(d);
    else runs.push([d]);
  }
  return runs
    .flatMap((r) =>
      r.length >= 3 ? [`${SHORT_DAYS[r[0]]}–${SHORT_DAYS[r.at(-1)!]}`] : r.map((d) => SHORT_DAYS[d]),
    )
    .join(", ");
}

/** "3–6 PM", "11 AM–2 PM". */
function describeHours(start: string, end: string): string {
  const a = formatTime(start);
  const b = formatTime(end);
  const suffix = a.slice(-2);
  return suffix === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
}

/** "Tue 3–6 PM", "Mon–Fri 11 AM–2 PM, Sat 3–6 PM". */
export function describeSchedule(schedule: WeeklyWindow[]): string {
  return schedule.map((w) => `${describeDays(w.days)} ${describeHours(w.start, w.end)}`).join(", ");
}

function nameList(ids: number[], names: Record<number, string> | undefined): string[] {
  return ids.map((i) => names?.[i]).filter((n): n is string => Boolean(n));
}

/**
 * What a target covers, without an article: "Large 14" Cheese Pizza",
 * "Large 14" item from Specialty Pizzas", "item". Lists join with "or".
 */
export function describeTarget(t: Target, names?: TargetNames): string {
  const mods = nameList(t.modifierIds, names?.modifiers).join(" or ");
  const items = nameList(t.itemIds, names?.items).join(" or ");
  const cats = nameList(t.categoryIds, names?.categories).join(" or ");
  const noun = items || (cats ? `item from ${cats}` : "item");
  return mods ? `${mods} ${noun}` : noun;
}

function countOf(n: number, phrase: string): string {
  return n === 1 ? `a ${phrase}` : `${n} × ${phrase}`;
}

function sameTarget(a: Target, b: Target): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function percentText(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** "Add a Large 14" Cheese Pizza to use this" for a reward with nothing to discount. */
function noQualifyingItemReason(reward: PromotionReward, names?: TargetNames): string {
  switch (reward.type) {
    case "item_percent":
    case "item_amount":
    case "item_price":
      return `Add ${countOf(1, describeTarget(reward.target, names))} to use this`;
    case "bogo": {
      const { buy, get } = reward;
      const what = sameTarget(buy.target, get.target)
        ? countOf(buy.quantity + get.quantity, describeTarget(buy.target, names))
        : `${countOf(buy.quantity, describeTarget(buy.target, names))} and ${countOf(get.quantity, describeTarget(get.target, names))}`;
      return `Add ${what} to use this`;
    }
    case "order_percent":
    case "order_amount":
    case "free_delivery":
      return "Add an item to use this";
  }
}

/** The reward in a few words: "20% off (up to $10)", "Buy 1 Large 14" item, get 1 free". */
export function describeReward(reward: PromotionReward, names?: TargetNames): string {
  switch (reward.type) {
    case "order_percent":
      return `${percentText(reward.percentBps)} off${reward.maxDiscountCents ? ` (up to ${formatCents(reward.maxDiscountCents)})` : ""}`;
    case "order_amount":
      return `${formatCents(reward.amountCents)} off`;
    case "item_percent":
      return `${percentText(reward.percentBps)} off any ${describeTarget(reward.target, names)}${limitText(reward.maxUnits)}`;
    case "item_amount":
      return `${formatCents(reward.amountCents)} off any ${describeTarget(reward.target, names)}${limitText(reward.maxUnits)}`;
    case "item_price":
      return `Any ${describeTarget(reward.target, names)} for ${formatCents(reward.priceCents)}${limitText(reward.maxUnits)}`;
    case "bogo": {
      const deal = reward.get.percentBps === 10_000 ? "free" : `${percentText(reward.get.percentBps)} off`;
      const getWhat = sameTarget(reward.buy.target, reward.get.target)
        ? `${reward.get.quantity}`
        : `${reward.get.quantity} ${describeTarget(reward.get.target, names)}`;
      const times = reward.maxApplications ? ` (up to ${reward.maxApplications}× per order)` : "";
      return `Buy ${reward.buy.quantity} ${describeTarget(reward.buy.target, names)}, get ${getWhat} ${deal}${times}`;
    }
    case "free_delivery":
      return "Free delivery";
  }
}

function limitText(maxUnits: number | null): string {
  return maxUnits ? ` (up to ${maxUnits})` : "";
}

/** "20% off orders $30+": the reward plus its minimum, for lists. */
export function describePromotionShort(p: Pick<PromotionTerms, "reward" | "minSubtotalCents">, names?: TargetNames): string {
  const reward = describeReward(p.reward, names);
  if (p.minSubtotalCents <= 0) return reward;
  const min = formatCents(p.minSubtotalCents).replace(/\.00$/, "");
  return p.reward.type === "order_percent" || p.reward.type === "order_amount"
    ? `${reward} orders ${min}+`
    : `${reward} on orders ${min}+`;
}

/**
 * The plain-English sentence a customer reads: reward, minimum, order type,
 * schedule, dates, limits, and the code when there is one.
 */
export function describeOffer(
  p: Omit<PromotionTerms, "id" | "name" | "isActive" | "archivedAt">,
  opts: { timezone: string; code?: string | null; names?: TargetNames },
): string {
  const parts = [`${describePromotionShort(p, opts.names)}.`];
  if (p.orderTypes.length === 1) parts.push(p.orderTypes[0] === "pickup" ? "Pickup orders only." : "Delivery orders only.");
  if (p.schedule?.length) parts.push(`Valid ${describeSchedule(p.schedule)}.`);
  if (p.startsAt && p.endsAt) {
    parts.push(`${formatDay(p.startsAt, opts.timezone)} through ${formatLastDay(p.endsAt, opts.timezone)}.`);
  } else if (p.startsAt) parts.push(`Starts ${formatDay(p.startsAt, opts.timezone)}.`);
  else if (p.endsAt) parts.push(`Ends ${formatLastDay(p.endsAt, opts.timezone)}.`);
  if (p.newCustomersOnly) parts.push("New customers only.");
  if (p.perCustomerLimit) parts.push(p.perCustomerLimit === 1 ? "Once per customer." : `Up to ${p.perCustomerLimit} times per customer.`);
  if (p.totalLimit) parts.push(`Limited to the first ${p.totalLimit} orders.`);
  if (!p.stackable) parts.push("Can't be combined with other offers.");
  if (p.trigger === "code") parts.push(opts.code ? `Use code ${opts.code}.` : "Requires a code.");
  else parts.push("Applied automatically.");
  return parts.join(" ");
}

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

export const REASONS = {
  unknown: "We don't recognize that code.",
  ended: "This offer has ended.",
  soldOut: "This code has been fully redeemed",
  perCustomer: "Already used with this phone number",
  newCustomers: "New customers only",
  pickupOnly: "Pickup orders only",
  deliveryOnly: "Delivery orders only",
  deliveryFree: "Delivery is already free",
  duplicate: "This offer is already applied",
  betterDeal: (names: string) => `A better deal is already applied: ${names}`,
} as const;

type Failure = { reason: string; shortCents?: number };

/**
 * The first reason this candidate can't apply, or null. Hard stops come
 * first (ended, used up, already used) so a customer is never told to add
 * $4 for an offer that still wouldn't work; the fixable ones follow.
 */
function firstFailure(c: PromotionCandidate, input: EvaluateInput): Failure | null {
  const p = c.promotion;
  const { now, timezone } = input;
  if (!p.isActive || p.archivedAt) return { reason: REASONS.ended };
  if (p.startsAt && p.startsAt > now) return { reason: `Starts ${formatDay(p.startsAt, timezone)}` };
  if (p.endsAt && p.endsAt <= now) return { reason: `Ended ${formatLastDay(p.endsAt, timezone)}` };
  if ((p.totalLimit !== null && c.uses >= p.totalLimit) || (c.code?.maxUses != null && c.code.uses >= c.code.maxUses)) {
    return { reason: REASONS.soldOut };
  }
  if (input.customerKey) {
    if (p.perCustomerLimit !== null && c.customerUses >= p.perCustomerLimit) return { reason: REASONS.perCustomer };
    if (p.newCustomersOnly && input.customerHasOrdered) return { reason: REASONS.newCustomers };
  }
  if (!inSchedule(p.schedule, now, timezone)) return { reason: `Valid ${describeSchedule(p.schedule ?? [])}` };
  if (!p.orderTypes.includes(input.orderType)) {
    return { reason: input.orderType === "pickup" ? REASONS.deliveryOnly : REASONS.pickupOnly };
  }
  if (p.reward.type === "free_delivery") {
    if (input.orderType === "pickup") return { reason: REASONS.deliveryOnly };
    if (input.deliveryFeeCents === 0) return { reason: REASONS.deliveryFree };
  }
  const short = p.minSubtotalCents - input.subtotalCents;
  if (short > 0) {
    return { reason: `Add ${formatCents(short)} more to use ${c.code?.display ?? p.name}`, shortCents: short };
  }
  if (applyReward(p.reward, freshState(input), input.lines) === 0) {
    return { reason: noQualifyingItemReason(p.reward, input.names) };
  }
  return null;
}

/** True when the only thing missing is the minimum subtotal. */
function onlyShortOfMinimum(c: PromotionCandidate, input: EvaluateInput): number | null {
  const failure = firstFailure(c, input);
  if (!failure?.shortCents) return null;
  const topUp = { ...input, subtotalCents: c.promotion.minSubtotalCents };
  return firstFailure(c, topUp) === null ? failure.shortCents : null;
}

function nudgeMessage(c: PromotionCandidate, shortCents: number): string {
  const short = formatCents(shortCents);
  if (c.code) return `Add ${short} more to use ${c.code.display}`;
  if (c.promotion.reward.type === "free_delivery") return `Add ${short} more for free delivery`;
  return `Add ${short} more to get ${c.promotion.name}`;
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
  const seenPromotions = new Set<number>();

  const automatic = input.candidates.filter((c) => c.code === null && c.promotion.trigger === "automatic");
  const byCode = new Map(
    input.candidates.filter((c) => c.code !== null).map((c) => [c.code!.code, c] as const),
  );

  for (const c of automatic) {
    if (seenPromotions.has(c.promotion.id)) continue;
    seenPromotions.add(c.promotion.id);
    if (firstFailure(c, input) === null) eligible.push(c);
    else {
      const short = onlyShortOfMinimum(c, input);
      if (short !== null) nudges.push({ promotionId: c.promotion.id, message: nudgeMessage(c, short) });
    }
  }

  for (const code of new Set(input.enteredCodes)) {
    const c = byCode.get(code);
    if (!c) {
      rejected.push({ code, reason: REASONS.unknown });
      continue;
    }
    if (seenPromotions.has(c.promotion.id)) {
      rejected.push({ code, reason: REASONS.duplicate });
      continue;
    }
    seenPromotions.add(c.promotion.id);
    const failure = firstFailure(c, input);
    if (failure === null) {
      eligible.push(c);
      continue;
    }
    rejected.push({ code, reason: failure.reason });
    const short = onlyShortOfMinimum(c, input);
    if (short !== null) nudges.push({ promotionId: c.promotion.id, message: nudgeMessage(c, short) });
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
  const winners = new Set(applied.map((a) => a.promotionId));
  const names = applied.map((a) => a.label).join(" + ");
  for (const c of eligible) {
    if (c.code && !winners.has(c.promotion.id)) {
      rejected.push({ code: c.code.code, reason: REASONS.betterDeal(names) });
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

export const PROMOTION_STATUS_LABEL: Record<PromotionStatus, string> = {
  active: "Active",
  scheduled: "Scheduled",
  expired: "Expired",
  paused: "Paused",
  used_up: "Used up",
  archived: "Archived",
};

/** Derived from the data, never stored. */
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
