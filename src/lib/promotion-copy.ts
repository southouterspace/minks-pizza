/**
 * Every sentence customers and operators read about a deal: offer
 * summaries, refusals, nudges, a deal lost to a race, status labels. The
 * evaluator returns data; this module owns the words.
 */
import { DAY_NAMES, formatTime } from "./hours";
import { formatCents } from "./money";
import type { Nudge, PromotionStatus, PromotionTerms, Refusal } from "./promotion-engine";
import { REWARD_SPEC, sameTarget, type PromotionReward, type Target, type WeeklyWindow } from "./promotion-schema";

/** Display names for target ids, for "Add a Large 14" Cheese Pizza to use this". */
export type TargetNames = {
  categories: Record<number, string>;
  items: Record<number, string>;
  modifiers: Record<number, string>;
};

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

function percentText(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
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
  return REWARD_SPEC[p.reward.type].scope === "order"
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

function countOf(n: number, phrase: string): string {
  return n === 1 ? `a ${phrase}` : `${n} × ${phrase}`;
}

/** "Add a Large 14" Cheese Pizza to use this" for a reward with nothing to discount. */
function noQualifyingCopy(reward: PromotionReward, names?: TargetNames): string {
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

/** Why a code didn't apply, as one sentence without a closing period. */
export function refusalCopy(
  r: Refusal,
  ctx: { display: string; timezone: string; names?: TargetNames },
): string {
  switch (r.kind) {
    case "unknown":
      return "We don't recognize that code";
    case "duplicate":
      return "This offer is already applied";
    case "ended":
      return "This offer has ended";
    case "notStarted":
      return `Starts ${formatDay(r.startsAt, ctx.timezone)}`;
    case "expired":
      return `Ended ${formatLastDay(r.endsAt, ctx.timezone)}`;
    case "soldOut":
      return "This code has been fully redeemed";
    case "perCustomer":
      return "Already used with this phone number";
    case "newCustomers":
      return "New customers only";
    case "schedule":
      return `Valid ${describeSchedule(r.schedule)}`;
    case "orderType":
      return r.only === "pickup" ? "Pickup orders only" : "Delivery orders only";
    case "deliveryFree":
      return "Delivery is already free";
    case "short":
      return `Add ${formatCents(r.shortCents)} more to use ${ctx.display}`;
    case "noQualifying":
      return noQualifyingCopy(r.reward, ctx.names);
    case "betterDeal":
      return `A better deal is already applied: ${r.winners.join(" + ")}`;
  }
}

/** "Add $3.20 more for free delivery". */
export function nudgeCopy(n: Nudge): string {
  const short = formatCents(n.shortCents);
  if (n.code) return `Add ${short} more to use ${n.code}`;
  if (n.rewardType === "free_delivery") return `Add ${short} more for free delivery`;
  return `Add ${short} more to get ${n.name}`;
}

/**
 * Why an order wasn't placed at the total the customer saw, naming the deal
 * that changed. A sold-out deal went to another order moments ago, so it
 * says "just"; anything else quotes the refusal the cart shows.
 */
export function dealChangedMessage(
  deal: { display: string; refusal: Refusal | undefined } | undefined,
  totalCents: number,
  ctx: { timezone: string; names?: TargetNames },
): string {
  const total = formatCents(totalCents);
  if (deal?.refusal?.kind === "soldOut") return `${deal.display} was just fully redeemed — your total is now ${total}.`;
  const why = deal
    ? `${deal.display}: ${deal.refusal ? refusalCopy(deal.refusal, { ...ctx, display: deal.display }) : "This deal is no longer available"}. `
    : "";
  return `${why}Your total is now ${total}. Check it and place your order again.`;
}

export const PROMOTION_STATUS_LABEL: Record<PromotionStatus, string> = {
  active: "Active",
  scheduled: "Scheduled",
  expired: "Expired",
  paused: "Paused",
  used_up: "Used up",
  archived: "Archived",
};
