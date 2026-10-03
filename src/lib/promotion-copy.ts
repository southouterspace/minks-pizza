/**
 * Every sentence a customer reads about a refused deal, a nudge or a deal
 * lost to a race. The evaluator returns data; this module owns the words.
 */
import { formatCents } from "./money";
import {
  describeSchedule,
  describeTarget,
  formatDay,
  formatLastDay,
  sameTarget,
  type Nudge,
  type PromotionReward,
  type Refusal,
  type TargetNames,
} from "./promotions";

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
 * "PIZZA10 was just fully redeemed": a deal that applied at quote time and
 * was gone once the order went in, from why a fresh quote turned it down.
 */
export function lostDealCopy(lost: { code: string | null; label: string }, refusal: Refusal | undefined): string {
  if (!lost.code) return `"${lost.label}" just ran out`;
  switch (refusal?.kind) {
    case "perCustomer":
      return `${lost.code} was already used with this phone number`;
    case "newCustomers":
      return `${lost.code} is for new customers only`;
    case "soldOut":
      return `${lost.code} was just fully redeemed`;
    default:
      return `${lost.code} is no longer available`;
  }
}
