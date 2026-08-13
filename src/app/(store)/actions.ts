"use server";

import { checkoutSchema } from "@/lib/validation";
import { createOrder, OrderError } from "@/lib/orders";

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
