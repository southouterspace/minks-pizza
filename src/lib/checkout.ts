/**
 * The checkout: pricing, promotions and the loyalty program in one quote, and
 * placing an order from it. The live preview and the order insert both come
 * through quoteCheckout, so what the customer sees is what is charged.
 */
import { sql } from "drizzle-orm";
import { orders } from "@/db";
import {
  INSUFFICIENT_POINTS,
  activePromotion,
  applyReward,
  earnPoints,
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
import { getSettings, insertOrder, OrderError, priceCart, type PricedLine, type StoreSettings } from "@/lib/orders";
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
import type { CheckoutInput, PreviewInput } from "@/lib/validation";

export type CheckoutQuote = Evaluation & {
  lines: PricedLine[];
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
 * items. Tax is on the items after both, and points are earned on that too.
 * `member` earns, and spends when `rewardId` is set.
 */
export async function quoteCheckout(
  input: PreviewInput,
  member: LoyaltyMember | null,
  settings?: StoreSettings,
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
  const [cart, loaded] = await Promise.all([
    priceCart(input.lines, input.orderType, store),
    loadCandidates(input.promoCodes ?? [], customerKey),
  ]);
  const evaluation = evaluatePromotions({
    lines: cart.lines,
    orderType: input.orderType,
    subtotalCents: cart.subtotalCents,
    deliveryFeeCents: cart.deliveryFeeCents,
    now: new Date(),
    timezone: store.timezone,
    customerKey,
    customerHasOrdered: loaded.customerHasOrdered,
    enteredCodes: loaded.enteredCodes,
    candidates: loaded.candidates,
  });
  const itemsLeft =
    cart.subtotalCents - evaluation.applied.filter((a) => a.target === "items").reduce((n, a) => n + a.amountCents, 0);
  const redemption = capRedemption(
    program.enabled && rewardId !== null ? applyReward(reward, member, cart.lines) : { status: "none" },
    itemsLeft,
  );
  const rewardCents = redemption.status === "applied" ? redemption.discountCents : 0;
  const totals = discountedTotals({
    subtotalCents: cart.subtotalCents,
    deliveryFeeCents: cart.deliveryFeeCents,
    tipCents: 0,
    taxRateBps: store.taxRateBps,
    discounts: [...evaluation.applied, { amountCents: rewardCents, target: "items" }],
  });
  const pointPromo = program.enabled ? activePromotion(pointPromos, new Date(), store.timezone) : null;
  return {
    ...evaluation,
    discountCents: totals.discountCents,
    lines: cart.lines,
    subtotalCents: cart.subtotalCents,
    deliveryFeeCents: cart.deliveryFeeCents,
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
            netCents: itemsLeft - rewardCents,
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

function assertStoreTakes(settings: StoreSettings, orderType: CheckoutInput["orderType"]) {
  if (!settings.isPublished) {
    throw new OrderError("This store is not accepting online orders yet.");
  }
  if (!settings.isAcceptingOrders) {
    throw new OrderError("Online ordering is temporarily paused. Please call the store.");
  }
  if (orderType === "pickup" && !settings.pickupEnabled) {
    throw new OrderError("Pickup is not available right now.");
  }
  if (orderType === "delivery" && !settings.deliveryEnabled) {
    throw new OrderError("Delivery is not available right now.");
  }
}

/**
 * Creates an order (payment_status = 'pending').
 *
 * STRIPE SEAM: when payments land, create a PaymentIntent for
 * `totalCents` here (or in a wrapping action), store its id on the order,
 * and flip payment_status to 'paid' from the Stripe webhook. Everything
 * upstream (validation, pricing) and downstream (confirmation page,
 * admin inbox) already works off the persisted order.
 *
 * `signedIn` is the member from the session, never from the client; only
 * they can spend points. A guest who opts in earns on their phone number.
 */
export async function createOrder(input: CheckoutInput, signedIn: LoyaltyMember | null = null) {
  const [settings, program] = await Promise.all([getSettings(), getLoyaltySettings()]);
  assertStoreTakes(settings, input.orderType);
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
    const redemption = quote.loyalty?.redemption ?? { status: "none" };
    if (redemption.status === "rejected") throw new OrderError(redemption.error);
    const totalCents = quote.totalBeforeTipCents + input.tipCents;
    if (input.expectedTotalCents !== undefined && input.expectedTotalCents !== totalCents) {
      const changed = quote.rejected.find((r) => r.refusal.kind !== "unknown");
      throw new OrderError(dealChangedMessage(changed, totalCents, quote));
    }
    if (input.orderType === "delivery" && quote.subtotalCents < settings.deliveryMinimumCents) {
      throw new OrderError(
        `Delivery orders have a minimum subtotal of $${(settings.deliveryMinimumCents / 100).toFixed(2)}.`,
      );
    }
    const reward = redemption.status === "applied" ? redemption : null;
    const order = await insertOrder(
      {
        input,
        prepMinutes: input.orderType === "delivery" ? settings.deliveryPrepMinutes : settings.pickupPrepMinutes,
        lines: quote.lines,
        subtotalCents: quote.subtotalCents,
        discountCents: quote.discountCents,
        taxCents: quote.taxCents,
        deliveryFeeCents: quote.deliveryFeeCents,
        totalCents,
        discounts: quote.applied,
        loyalty: quote.loyalty && {
          memberId: signedIn?.id ?? null,
          reward: reward && {
            name: reward.reward.name,
            pointsCost: reward.reward.price.cost,
            discountCents: reward.discountCents,
          },
          pointsEarned: quote.loyalty.pointsEarned,
        },
      },
      redemptionCheck(quote.applied, customerKey),
      (orderId) => [
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
    ).catch((err) => {
      // Another order spent these points first: the debit tripped the balance CHECK.
      if (isInsufficientPoints(err)) throw new OrderError(INSUFFICIENT_POINTS);
      throw err;
    });
    if (order) return order;
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
