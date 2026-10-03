"use server";

import { randomUUID } from "node:crypto";
import { checkoutSchema, type CheckoutInput } from "@/lib/validation";
import { submitOrder } from "@/lib/orders-server/submit";
import type { Fulfillment, SubmitOrderRequest } from "@/lib/orders";

export type PlaceOrderResult =
  | { ok: true; orderId: string }
  | { ok: false; error: string };

function fulfillmentOf(input: CheckoutInput): Fulfillment {
  if (input.orderType === "pickup") return { kind: "pickup" };
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
 * Customer order submission. Everything is re-validated and re-priced
 * server-side; the client cart is only a proposal.
 *
 * STRIPE SEAM: once payments are added, this action will create the
 * PaymentIntent after `submitOrder` and return its client secret alongside
 * the orderId for confirmation on the client.
 */
export async function placeOrder(input: unknown): Promise<PlaceOrderResult> {
  const parsed = checkoutSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first?.message ?? "Invalid order." };
  }
  const data = parsed.data;
  const request: SubmitOrderRequest = {
    orderId: randomUUID(),
    channel: "online",
    fulfillment: fulfillmentOf(data),
    customer: {
      phone: data.customerPhone,
      name: data.customerName,
      email: data.customerEmail || null,
      saveAddress: data.orderType === "delivery",
    },
    notes: data.orderNotes || null,
    fire: { kind: "now" },
    promisedAt: null,
    tipCents: data.tipCents,
    lines: data.lines.map((l) => ({ ...l, lineId: randomUUID() })),
    tenders: [],
  };

  try {
    const result = await submitOrder(request, { kind: "online" });
    if (result.ok) return { ok: true, orderId: result.order.id };
    return {
      ok: false,
      error: result.reason === "rejected" ? result.message : "We couldn't place your order. Please try again.",
    };
  } catch (err) {
    console.error("placeOrder failed:", err);
    return {
      ok: false,
      error: "Something went wrong placing your order. Please try again.",
    };
  }
}
