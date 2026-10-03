"use server";

import { checkoutSchema, previewSchema } from "@/lib/validation";
import { createOrder, OrderError, quoteCheckout } from "@/lib/orders";
import { formatLastDay, type DiscountTarget, type Nudge, type Rejection } from "@/lib/promotions";

export type QuoteView = {
  subtotalCents: number;
  discounts: {
    promotionId: number;
    code: string | null;
    label: string;
    amountCents: number;
    target: DiscountTarget;
    /** "Ends Oct 31" when the offer has an end date. */
    ends: string | null;
  }[];
  rejected: Rejection[];
  nudges: Nudge[];
  discountCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  totalBeforeTipCents: number;
};

export type PreviewResult = { ok: true; quote: QuoteView } | { ok: false; error: string };

/** Live totals for the cart and checkout, from the same path that places the order. */
export async function previewCheckout(input: unknown): Promise<PreviewResult> {
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Couldn't price your cart." };
  if (parsed.data.lines.length === 0) {
    return {
      ok: true,
      quote: {
        subtotalCents: 0,
        discounts: [],
        rejected: [],
        nudges: [],
        discountCents: 0,
        taxCents: 0,
        deliveryFeeCents: 0,
        totalBeforeTipCents: 0,
      },
    };
  }
  try {
    const q = await quoteCheckout(parsed.data);
    return {
      ok: true,
      quote: {
        subtotalCents: q.subtotalCents,
        discounts: q.applied.map((a) => ({
          promotionId: a.promotionId,
          code: a.code,
          label: a.label,
          amountCents: a.amountCents,
          target: a.target,
          ends: a.endsAt ? `Ends ${formatLastDay(a.endsAt, q.timezone)}` : null,
        })),
        rejected: q.rejected,
        nudges: q.nudges,
        discountCents: q.discountCents,
        taxCents: q.taxCents,
        deliveryFeeCents: q.deliveryFeeCents,
        totalBeforeTipCents: q.totalBeforeTipCents,
      },
    };
  } catch (err) {
    if (err instanceof OrderError) return { ok: false, error: err.message };
    console.error("previewCheckout failed:", err);
    return { ok: false, error: "Couldn't price your cart. Please try again." };
  }
}

export type PlaceOrderResult =
  | { ok: true; orderId: string }
  | { ok: false; error: string };

/**
 * Customer order submission. Everything is re-validated and re-priced
 * server-side; the client cart is only a proposal.
 *
 * STRIPE SEAM: once payments are added, this action will create the
 * PaymentIntent after `createOrder` and return its client secret alongside
 * the orderId for confirmation on the client.
 */
export async function placeOrder(input: unknown): Promise<PlaceOrderResult> {
  const parsed = checkoutSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first?.message ?? "Invalid order." };
  }

  try {
    const order = await createOrder(parsed.data);
    return { ok: true, orderId: order.id };
  } catch (err) {
    if (err instanceof OrderError) {
      return { ok: false, error: err.message };
    }
    console.error("placeOrder failed:", err);
    return {
      ok: false,
      error: "Something went wrong placing your order. Please try again.",
    };
  }
}
