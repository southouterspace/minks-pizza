/**
 * The checkout: pricing plus promotions in one quote, and placing an order
 * from it. The live preview and the order insert both come through
 * quoteCheckout, so what the customer sees is what is charged.
 */
import { formatCents } from "@/lib/money";
import { getSettings, insertOrder, OrderError, priceCart, type PricedLine, type StoreSettings } from "@/lib/orders";
import { normalizeCode } from "@/lib/promo-code";
import { lostDealCopy, refusalCopy, type TargetNames } from "@/lib/promotion-copy";
import {
  customerKeyFromPhone,
  discountedTotals,
  evaluatePromotions,
  type AppliedDiscount,
  type Evaluation,
} from "@/lib/promotion-engine";
import { loadCandidates } from "@/lib/promotion-queries";
import { redemptionGuard } from "@/lib/promotion-usage";
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
};

export async function quoteCheckout(input: PreviewInput, settings?: StoreSettings): Promise<CheckoutQuote> {
  const store = settings ?? (await getSettings());
  const customerKey = customerKeyFromPhone(input.customerPhone);
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
  const totals = discountedTotals({
    subtotalCents: cart.subtotalCents,
    deliveryFeeCents: cart.deliveryFeeCents,
    tipCents: 0,
    taxRateBps: store.taxRateBps,
    discounts: evaluation.applied,
  });
  return {
    ...evaluation,
    lines: cart.lines,
    subtotalCents: cart.subtotalCents,
    deliveryFeeCents: cart.deliveryFeeCents,
    taxCents: totals.taxCents,
    totalBeforeTipCents: totals.totalCents,
    timezone: store.timezone,
    names: loaded.names,
    customerKey,
  };
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

/** "E2E-PIZZA: This offer has ended. Your total is now $38.91. …", in the customer's own spelling. */
function totalChangedMessage(input: CheckoutInput, quote: CheckoutQuote, totalCents: number): string {
  const rejected = quote.rejected[0];
  const typed = rejected && (input.promoCodes ?? []).find((c) => normalizeCode(c) === rejected.code);
  const why = rejected
    ? `${(typed ?? rejected.code).toUpperCase()}: ${refusalCopy(rejected.refusal, { display: rejected.display, timezone: quote.timezone, names: quote.names })}. `
    : "";
  return `${why}Your total is now ${formatCents(totalCents)}. Check it and place your order again.`;
}

/** "PIZZA10 was just fully redeemed — your total is now $12.97.", from why a fresh quote refuses the deal. */
function lostRaceMessage(input: CheckoutInput, lost: AppliedDiscount | undefined, fresh: CheckoutQuote): string {
  const code = lost?.code && normalizeCode(lost.code);
  const what = lost ? lostDealCopy(lost, fresh.rejected.find((r) => r.code === code)?.refusal) : "A deal on your order just changed";
  return `${what} — your total is now ${formatCents(fresh.totalBeforeTipCents + input.tipCents)}.`;
}

/**
 * Creates an order (payment_status = 'pending').
 *
 * STRIPE SEAM: when payments land, create a PaymentIntent for
 * `totalCents` here (or in a wrapping action), store its id on the order,
 * and flip payment_status to 'paid' from the Stripe webhook. Everything
 * upstream (validation, pricing) and downstream (confirmation page,
 * admin inbox) already works off the persisted order.
 */
export async function createOrder(input: CheckoutInput) {
  const settings = await getSettings();
  assertStoreTakes(settings, input.orderType);
  const customerKey = customerKeyFromPhone(input.customerPhone);
  if (!customerKey) throw new OrderError("Enter a valid phone number");

  let quote = await quoteCheckout(input, settings);
  for (let attempt = 0; ; attempt++) {
    const totalCents = quote.totalBeforeTipCents + input.tipCents;
    if (input.expectedTotalCents !== undefined && input.expectedTotalCents !== totalCents) {
      throw new OrderError(totalChangedMessage(input, quote, totalCents));
    }
    if (input.orderType === "delivery" && quote.subtotalCents < settings.deliveryMinimumCents) {
      throw new OrderError(
        `Delivery orders have a minimum subtotal of $${(settings.deliveryMinimumCents / 100).toFixed(2)}.`,
      );
    }
    const order = await insertOrder(
      {
        input,
        customerKey,
        prepMinutes: input.orderType === "delivery" ? settings.deliveryPrepMinutes : settings.pickupPrepMinutes,
        lines: quote.lines,
        subtotalCents: quote.subtotalCents,
        discountCents: quote.discountCents,
        taxCents: quote.taxCents,
        deliveryFeeCents: quote.deliveryFeeCents,
        totalCents,
        discounts: quote.applied,
      },
      redemptionGuard(quote.applied, customerKey),
    );
    if (order) return order;
    // The guard failed: a deal's limit went to another order since the quote.
    const fresh = await quoteCheckout(input, settings);
    const lost = quote.applied.find((a) => !fresh.applied.some((f) => f.promotionId === a.promotionId));
    if (lost || attempt > 0) throw new OrderError(lostRaceMessage(input, lost, fresh));
    quote = fresh;
  }
}
