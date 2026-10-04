"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { cartLineSchema, checkoutSchema, previewSchema } from "@/lib/validation";
import { priceLines } from "@/lib/menu-server";
import { getSettings, policyOf } from "@/lib/settings-server";
import { createOrder, pricedCaps, quoteCheckout } from "@/lib/checkout";
import { getCurrentMember } from "@/lib/member-auth";
import { rewardOptions, type RewardOption } from "@/lib/loyalty-server";
import { OrderError } from "@/lib/checkout";
import { formatLastDay, nudgeCopy, refusalCopy } from "@/lib/promotion-copy";
import type { DiscountTarget } from "@/lib/promotion-schema";

export type QuoteView = {
  subtotalCents: number;
  /** Per cart line, the most the stock allows alongside the rest; null where nothing tracked limits it. */
  caps: (number | null)[];
  discounts: {
    key: string;
    kind: "promotion" | "loyalty";
    code: string | null;
    label: string;
    amountCents: number;
    target: DiscountTarget;
    /** "Ends Oct 31" for an offer with an end date; the points a reward spends. */
    note: string | null;
  }[];
  /** Each refused code (normalized) with the sentence shown under the field. */
  rejected: { code: string; reason: string }[];
  nudges: { promotionId: number; message: string }[];
  discountCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  totalBeforeTipCents: number;
  /** Alcohol in the cart makes the order pickup only. */
  hasAlcohol: boolean;
  /** Null when the program is off. */
  loyalty: {
    pointsEarned: number;
    promoName: string | null;
    rewardError: string | null;
    /** With `withRewards`, for signed-in members: each active reward and whether it fits this cart. */
    rewards: RewardOption[];
  } | null;
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
        caps: [],
        discounts: [],
        rejected: [],
        nudges: [],
        discountCents: 0,
        taxCents: 0,
        deliveryFeeCents: 0,
        totalBeforeTipCents: 0,
        hasAlcohol: false,
        loyalty: null,
      },
    };
  }
  try {
    const member = await getCurrentMember();
    const q = await quoteCheckout(parsed.data, member);
    const redemption = q.loyalty?.redemption;
    const rewards = parsed.data.withRewards && member && q.loyalty ? await rewardOptions(q.lines, q.timezone) : [];
    return {
      ok: true,
      quote: {
        subtotalCents: q.subtotalCents,
        caps: q.caps,
        discounts: [
          ...q.applied.map((a) => ({
            key: `promotion:${a.promotionId}`,
            kind: "promotion" as const,
            code: a.code,
            label: a.label,
            amountCents: a.amountCents,
            target: a.target,
            note: a.endsAt ? `Ends ${formatLastDay(a.endsAt, q.timezone)}` : null,
          })),
          ...(redemption?.status === "applied"
            ? [
                {
                  key: "loyalty",
                  kind: "loyalty" as const,
                  code: null,
                  label: redemption.reward.name,
                  amountCents: redemption.discountCents,
                  target: "items" as const,
                  note: `${redemption.reward.price.cost.toLocaleString()} points`,
                },
              ]
            : []),
        ],
        rejected: q.rejected.map((r) => ({
          code: r.code,
          reason: refusalCopy(r.refusal, { display: r.display, timezone: q.timezone, names: q.names }),
        })),
        nudges: q.nudges.map((n) => ({ promotionId: n.promotionId, message: nudgeCopy(n) })),
        discountCents: q.discountCents,
        taxCents: q.taxCents,
        deliveryFeeCents: q.deliveryFeeCents,
        totalBeforeTipCents: q.totalBeforeTipCents,
        hasAlcohol: q.lines.some((l) => l.isAlcoholic),
        loyalty: q.loyalty && {
          pointsEarned: q.loyalty.pointsEarned,
          promoName: q.loyalty.promoName,
          rewardError: redemption?.status === "rejected" ? redemption.error : null,
          rewards,
        },
      },
    };
  } catch (err) {
    if (err instanceof OrderError) return { ok: false, error: err.message };
    console.error("previewCheckout failed:", err);
    return { ok: false, error: "Couldn't price your cart. Please try again." };
  }
}

const addableSchema = z.object({ cart: z.array(cartLineSchema).max(50), line: cartLineSchema });

/**
 * How many of `line` the stock lets the customer add to `cart`, or null when
 * nothing tracked limits it. Matches what checkout will accept.
 */
export async function addableQuantity(input: unknown): Promise<number | null> {
  const parsed = addableSchema.safeParse(input);
  if (!parsed.success) return null;
  const { cart, line } = parsed.data;
  const store = policyOf(await getSettings());
  const priced = await priceLines(
    [...cart, { ...line, quantity: 1 }].map((l) => ({ ...l, lineId: randomUUID() })),
    store,
  );
  // An unpriceable cart is refused at checkout with its own message.
  if (!Array.isArray(priced)) return null;
  return (await pricedCaps(priced)).at(-1) ?? null;
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
