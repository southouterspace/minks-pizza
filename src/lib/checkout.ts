/**
 * The storefront checkout: pricing, promotions and the loyalty program in one
 * quote, and placing an order from it through the shared order write path.
 * The live preview and the order insert both come through quoteCheckout, so
 * what the customer sees is what is charged.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { orders } from "@/db";
import {
  INSUFFICIENT_POINTS,
  activePromotion,
  applyReward,
  earnPoints,
  earnableNetCents,
  normalizePhone,
  tierFor,
  type Redemption,
} from "@/lib/loyalty";
import {
  enrollStatements,
  getLoyaltySettings,
  getReward,
  isInsufficientPoints,
  ledgerKey,
  ledgerStatement,
  listPromotions,
  memberByPhone,
  qualifyingPoints,
  type LoyaltyMember,
  type LoyaltyReward,
} from "@/lib/loyalty-server";
import { stockCaps } from "@/lib/inventory";
import { priceLines, type PricedLine } from "@/lib/menu-server";
import type { Fulfillment, OrderView, SubmitOrderRequest } from "@/lib/orders";
import { DealChangedError, submitOrder } from "@/lib/orders-server/submit";
import { normalizeCode } from "@/lib/promo-code";
import { dealChangedMessage, type TargetNames } from "@/lib/promotion-copy";
import {
  customerKeyFromPhone,
  discountedTotals,
  evaluatePromotions,
  type Evaluation,
} from "@/lib/promotion-engine";
import { loadCandidates } from "@/lib/promotion-queries";
import { redemptionCheck } from "@/lib/promotion-usage";
import { getSettings, policyOf, type Settings } from "@/lib/settings-server";
import type { CheckoutInput, PreviewInput } from "@/lib/validation";

/** A refusal the customer should read: a closed store, a sold-out deal, an item gone from the menu. */
export class OrderError extends Error {}

export type CheckoutQuote = Evaluation & {
  lines: PricedLine[];
  /** Per line, the most the stock allows alongside the rest of the cart; null where nothing tracked limits it. */
  caps: (number | null)[];
  subtotalCents: number;
  deliveryFeeCents: number;
  taxCents: number;
  /** Everything but the tip, which the customer picks. */
  totalBeforeTipCents: number;
  timezone: string;
  /** For the words of a refusal. */
  names: TargetNames;
  customerKey: string | null;
  /** Null when the program is off. */
  loyalty: {
    programName: string;
    /** A rejected redemption means the order would be refused. */
    redemption: Redemption<LoyaltyReward>;
    pointsEarned: number;
    promoName: string | null;
  } | null;
};

/**
 * Promotions apply first; a loyalty reward then comes off what is left of the
 * items. Tax is on the items after both, and points are earned on that too,
 * less any alcohol.
 * `member` earns, and spends when `rewardId` is set.
 */
export async function quoteCheckout(
  input: PreviewInput,
  member: LoyaltyMember | null,
  settings?: Settings,
): Promise<CheckoutQuote> {
  const rewardId = input.rewardId ?? null;
  const customerKey = customerKeyFromPhone(input.customerPhone);
  const [store, program, pointPromos, reward, qualifying] = await Promise.all([
    settings ?? getSettings(),
    getLoyaltySettings(),
    listPromotions(),
    rewardId === null ? null : getReward(rewardId),
    member ? qualifyingPoints(member.id) : 0,
  ]);
  const [priced, loaded] = await Promise.all([
    priceLines(
      input.lines.map((l) => ({ ...l, lineId: randomUUID() })),
      policyOf(store),
    ),
    loadCandidates(input.promoCodes ?? [], customerKey),
  ]);
  if (!Array.isArray(priced)) {
    throw new OrderError(priced.reason === "rejected" ? priced.message : "Couldn't price your cart.");
  }
  const caps = await pricedCaps(priced);
  const subtotalCents = priced.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
  const deliveryFeeCents = input.orderType === "delivery" ? store.deliveryFeeCents : 0;
  const evaluation = evaluatePromotions({
    lines: priced,
    orderType: input.orderType,
    subtotalCents,
    deliveryFeeCents,
    now: new Date(),
    timezone: store.timezone,
    customerKey,
    customerHasOrdered: loaded.customerHasOrdered,
    enteredCodes: loaded.enteredCodes,
    candidates: loaded.candidates,
  });
  const itemsLeft =
    subtotalCents - evaluation.applied.filter((a) => a.target === "items").reduce((n, a) => n + a.amountCents, 0);
  const redemption = capRedemption(
    program.enabled && rewardId !== null ? applyReward(reward, member, priced) : { status: "none" },
    itemsLeft,
  );
  const rewardCents = redemption.status === "applied" ? redemption.discountCents : 0;
  const alcoholCents = priced.filter((l) => l.isAlcoholic).reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
  const totals = discountedTotals({
    subtotalCents,
    deliveryFeeCents,
    tipCents: 0,
    taxRateBps: store.taxRateBps,
    discounts: [...evaluation.applied, { amountCents: rewardCents, target: "items" }],
  });
  const pointPromo = program.enabled ? activePromotion(pointPromos, new Date(), store.timezone) : null;
  return {
    ...evaluation,
    discountCents: totals.discountCents,
    lines: priced,
    caps,
    subtotalCents,
    deliveryFeeCents,
    taxCents: totals.taxCents,
    totalBeforeTipCents: totals.totalCents,
    timezone: store.timezone,
    names: loaded.names,
    customerKey,
    loyalty: program.enabled
      ? {
          programName: program.programName,
          redemption,
          promoName: pointPromo?.name ?? null,
          pointsEarned: earnPoints({
            netCents: earnableNetCents({ subtotalCents, alcoholCents, discountCents: subtotalCents - itemsLeft + rewardCents }),
            pointsPerDollar: program.pointsPerDollar,
            tierMultiplierBps: tierFor(qualifying, program.tiers).multiplierBps,
            promoMultiplierBps: pointPromo?.multiplierBps ?? 10_000,
          }),
        }
      : null,
  };
}

/** A reward stacked on deals takes off at most what the deals left of the items. */
function capRedemption(r: Redemption<LoyaltyReward>, itemsLeftCents: number): Redemption<LoyaltyReward> {
  if (r.status !== "applied" || r.discountCents <= itemsLeftCents) return r;
  if (itemsLeftCents <= 0) return { status: "rejected", error: `Your deals already cover these items, so "${r.reward.name}" can't be used.` };
  return { ...r, discountCents: itemsLeftCents };
}

export function pricedCaps(lines: readonly PricedLine[]): Promise<(number | null)[]> {
  return stockCaps(lines.map((l) => ({ menuItemId: l.itemId, quantity: l.quantity, modifiers: l.modifiers })));
}

/** The refusal for the first line the stock can't cover, if any. */
function overStock({ lines, caps }: Pick<CheckoutQuote, "lines" | "caps">): string | null {
  const i = lines.findIndex((l, i) => caps[i] !== null && l.quantity > caps[i]);
  if (i < 0) return null;
  const cap = caps[i];
  return cap === 0
    ? `${lines[i].name} just sold out. Remove it from your cart to continue.`
    : `Only ${cap} of ${lines[i].name} can be made right now. Lower the quantity to continue.`;
}

function fulfillmentOf(input: CheckoutInput): Fulfillment {
  if (input.orderType === "pickup") return { kind: "pickup" };
  // checkoutSchema refuses a delivery without a street and ZIP.
  return {
    kind: "delivery",
    address: {
      line1: input.addressLine1 ?? "",
      line2: input.addressLine2 || null,
      city: input.city || null,
      zip: input.zip ?? "",
    },
  };
}

/**
 * Places a web order. Store-open and fulfillment checks run in submitOrder.
 *
 * STRIPE SEAM: when payments land, create a PaymentIntent for the total here
 * (or in a wrapping action), store its id on the order, and record the
 * payment as a tender from the Stripe webhook. Everything upstream
 * (validation, pricing) and downstream (confirmation page, admin inbox)
 * already works off the persisted order.
 *
 * `signedIn` is the member from the session, never from the client; only
 * they can spend points. A guest who opts in earns on their phone number.
 */
export async function createOrder(input: CheckoutInput, signedIn: LoyaltyMember | null = null): Promise<OrderView> {
  const [settings, program] = await Promise.all([getSettings(), getLoyaltySettings()]);
  const customerKey = customerKeyFromPhone(input.customerPhone);
  if (!customerKey) throw new OrderError("Enter a valid phone number");
  if (program.enabled && input.rewardId != null && !signedIn) {
    throw new OrderError("Sign in to use your points.");
  }

  const phone = normalizePhone(input.customerPhone);
  // A guest opting in is enrolled inside the order's batch, so a refused
  // order enrolls nobody. Until then a new phone earns like any new member.
  const joiningPhone = program.enabled && !signedIn && input.joinLoyalty && phone ? phone : null;
  const member = signedIn ?? (joiningPhone ? await memberByPhone(joiningPhone) : null);

  let quote = await quoteCheckout(input, member, settings);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const short = overStock(quote);
    if (short) throw new OrderError(short);
    const redemption = quote.loyalty?.redemption ?? { status: "none" };
    if (redemption.status === "rejected") throw new OrderError(redemption.error);
    const totalCents = quote.totalBeforeTipCents + input.tipCents;
    if (input.expectedTotalCents !== undefined && input.expectedTotalCents !== totalCents) {
      const changed = quote.rejected.find((r) => r.refusal.kind !== "unknown");
      throw new OrderError(dealChangedMessage(changed, totalCents, quote));
    }
    const reward = redemption.status === "applied" ? redemption : null;
    const request: SubmitOrderRequest = {
      orderId: randomUUID(),
      source: "web",
      fulfillment: fulfillmentOf(input),
      customer: {
        phone: input.customerPhone,
        name: input.customerName,
        email: input.customerEmail || null,
        saveAddress: input.orderType === "delivery",
      },
      notes: input.orderNotes || null,
      fire: { kind: "now" },
      promisedAt: null,
      tipCents: input.tipCents,
      lines: quote.lines.map((l) => ({ lineId: l.lineId, itemId: l.itemId, quantity: l.quantity, selections: l.selections, notes: l.notes })),
      tenders: [],
    };
    const result = await submitOrder(request, {
      kind: "online",
      quote: {
        discounts: quote.applied,
        reward: reward && {
          name: reward.reward.name,
          pointsCost: reward.reward.price.cost,
          discountCents: reward.discountCents,
        },
        memberId: signedIn?.id ?? null,
        pointsEarned: quote.loyalty?.pointsEarned ?? 0,
        check: redemptionCheck(quote.applied, customerKey),
        after: (orderId) => [
          ...(quote.loyalty && joiningPhone ? enrollStatements(orderId, joiningPhone, input.customerName) : []),
          // Selected from the order row, so a refused order spends nothing.
          ...(reward && signedIn
            ? [
                ledgerStatement({
                  kind: "redeem",
                  idemKey: ledgerKey.redeem(orderId),
                  orderId,
                  note: reward.reward.name,
                  from: sql`select ${signedIn.id}::int as member_id, ${-reward.reward.price.cost}::int as points
                    from ${orders} where ${orders.id} = ${orderId}`,
                }),
              ]
            : []),
        ],
      },
    }).catch((err: unknown) => {
      // Another order spent these points first: the debit tripped the balance CHECK.
      if (isInsufficientPoints(err)) throw new OrderError(INSUFFICIENT_POINTS);
      if (err instanceof DealChangedError) return null;
      throw err;
    });
    if (result) {
      if (result.ok) return result.order;
      throw new OrderError(result.reason === "rejected" ? result.message : "We couldn't place your order. Please try again.");
    }
    // The guard failed: a deal's limit went to another order since the quote.
    const fresh = await quoteCheckout(input, member, settings);
    const lost = quote.applied.find((a) => !fresh.applied.some((f) => f.promotionId === a.promotionId));
    if (lost) {
      const code = lost.code && normalizeCode(lost.code);
      const refusal = fresh.rejected.find((r) => r.code === code)?.refusal;
      const display = lost.code ?? `"${lost.label}"`;
      throw new OrderError(dealChangedMessage({ display, refusal }, fresh.totalBeforeTipCents + input.tipCents, fresh));
    }
    quote = fresh;
  }
  throw new OrderError("A deal on your order just changed. Check your total and place your order again.");
}
