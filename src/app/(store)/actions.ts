"use server";

import { z } from "zod";
import { cartLineSchema, checkoutSchema } from "@/lib/validation";
import { createOrder, OrderError, quoteOrder } from "@/lib/orders";
import { getCurrentMember } from "@/lib/member-auth";
import { rewardDiscount, rewardValueCents } from "@/lib/loyalty";
import { listRewards } from "@/lib/loyalty-server";

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
    const order = await createOrder(parsed.data, await getCurrentMember());
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

const previewSchema = z.object({
  orderType: z.enum(["pickup", "delivery"]),
  lines: z.array(cartLineSchema).min(1).max(50),
  rewardId: z.number().int().positive().nullable(),
});

export type CheckoutPreview =
  | {
      ok: true;
      subtotalCents: number;
      discountCents: number;
      taxCents: number;
      deliveryFeeCents: number;
      totalCents: number; // before tip
      pointsEarned: number | null;
      promoName: string | null;
      rewardError: string | null;
      /** Signed-in members only: each active reward and whether it fits this cart. */
      rewards: {
        id: number;
        name: string;
        description: string | null;
        pointsCost: number;
        valueCents: number;
        upTo: boolean;
        increase: { cost: number; on: string } | null;
        pointsShort: number;
        fitsCart: boolean;
      }[];
    }
  | { ok: false; error: string };

export async function previewCheckout(input: unknown): Promise<CheckoutPreview> {
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid cart." };
  try {
    const member = await getCurrentMember();
    const q = await quoteOrder(parsed.data, member);
    const rewards =
      member && q.loyalty
        ? (await listRewards({ activeOnly: true })).map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            pointsCost: r.price.cost,
            valueCents: rewardValueCents(r.effect),
            upTo: r.effect.kind === "free_item",
            increase: r.price.increase && { cost: r.price.increase.cost, on: r.price.increase.on.toISOString() },
            pointsShort: Math.max(0, r.price.cost - member.pointsBalance),
            fitsCart: rewardDiscount(r.effect, q.lines).ok,
          }))
        : [];
    return {
      ok: true,
      rewards,
      subtotalCents: q.subtotalCents,
      discountCents: q.discountCents,
      taxCents: q.taxCents,
      deliveryFeeCents: q.deliveryFeeCents,
      totalCents: q.totalCents,
      pointsEarned: q.loyalty?.pointsEarned ?? null,
      promoName: q.loyalty?.promoName ?? null,
      rewardError: q.loyalty?.redemption.status === "rejected" ? q.loyalty.redemption.error : null,
    };
  } catch (err) {
    if (err instanceof OrderError) return { ok: false, error: err.message };
    throw err;
  }
}
