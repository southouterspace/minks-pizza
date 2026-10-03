import { db, orders } from "@/db";
import { rejected, type MutationResult, type SubmitOrderRequest } from "@/lib/orders";
import { priceLines } from "@/lib/menu-server";
import { getSettings, policyOf, type Settings } from "@/lib/settings-server";
import { getOpenShift } from "@/lib/shifts-server";
import type { StaffContext } from "@/lib/staff";
import { folds, run } from "./folds";
import { getOrderView, getQuote } from "./views";
import {
  addressUpsert,
  customerUpsert,
  firing,
  fulfillmentColumns,
  insertLines,
  tenderInsert,
  tenderProblem,
} from "./writes";

export type Submitter = { kind: "pos"; staff: StaffContext } | { kind: "online" };

function onlineGate(req: SubmitOrderRequest, s: Settings): string | null {
  if (!s.isPublished) return "This store is not accepting online orders yet.";
  if (!s.isAcceptingOrders) return "Online ordering is temporarily paused. Please call the store.";
  switch (req.fulfillment.kind) {
    case "pickup":
      return s.pickupEnabled ? null : "Pickup is not available right now.";
    case "delivery":
      return s.deliveryEnabled ? null : "Delivery is not available right now.";
    case "dine_in":
      return "Dine-in orders are rung in at the counter.";
  }
}

/**
 * Prices on the server and writes the whole order in one batch. Replaying
 * the same request returns the stored order without writing anything.
 * Store-open, fulfillment and minimum checks apply to online orders only;
 * the counter can always ring an order in.
 */
export async function submitOrder(req: SubmitOrderRequest, by: Submitter): Promise<MutationResult> {
  const [existing, settings, shift] = await Promise.all([getOrderView(req.orderId), getSettings(), getOpenShift()]);
  if (existing) return { ok: true, order: existing };

  if (by.kind === "online") {
    if (req.channel !== "online" || req.tenders.length > 0) return rejected("Invalid online order.");
    const closed = onlineGate(req, settings);
    if (closed) return rejected(closed);
  } else if (req.channel === "online") {
    return rejected("The counter rings in walk-in and phone orders.");
  }
  if (req.lines.length === 0) return rejected("The order has no items.");

  const [priced, quote] = await Promise.all([priceLines(req.lines, policyOf(settings)), getQuote(settings)]);
  if (!Array.isArray(priced)) return priced;
  const subtotal = priced.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
  if (by.kind === "online" && req.fulfillment.kind === "delivery" && subtotal < settings.deliveryMinimumCents) {
    return rejected(`Delivery orders have a minimum subtotal of $${(settings.deliveryMinimumCents / 100).toFixed(2)}.`);
  }

  if (req.tenders.length > 0 && by.kind === "pos") {
    const problem = req.tenders.map(tenderProblem).find((p) => p !== null);
    if (problem) return rejected(problem);
    if (!shift) return { ok: false, reason: "no_open_shift" };
  }

  const now = new Date();
  const { fireNow, fireAt } = firing(req.fire, now);
  const quoted = req.fulfillment.kind === "delivery" ? quote.deliveryMinutes : quote.pickupMinutes;
  const promisedAt = req.promisedAt
    ? new Date(req.promisedAt)
    : new Date((fireAt ?? now).getTime() + quoted * 60_000);

  const customer = req.customer ? customerUpsert(req.customer) : null;
  const staffId = by.kind === "pos" ? by.staff.actor.employeeId : null;
  await run([
    ...(customer ? [customer.statement] : []),
    ...(customer && req.customer?.saveAddress ? addressUpsert(customer.id, req.fulfillment) : []),
    db
      .insert(orders)
      .values({
        id: req.orderId,
        status: "held",
        channel: req.channel,
        ...fulfillmentColumns(req.fulfillment, settings),
        customerId: customer ? customer.id : null,
        customerName: req.customer?.name ?? (req.fulfillment.kind === "dine_in" ? `Table ${req.fulfillment.table}` : "Walk-in"),
        customerPhone: req.customer?.phone ?? "",
        customerEmail: req.customer?.email ?? null,
        orderNotes: req.notes,
        createdBy: staffId,
        fireAt,
        promisedAt,
        tipCents: req.tipCents,
        taxRateBps: settings.taxRateBps,
      })
      .onConflictDoNothing({ target: orders.id }),
    ...insertLines(req.orderId, priced, fireNow),
    ...(shift && staffId !== null ? req.tenders.map((t) => tenderInsert(req.orderId, t, shift.id, staffId)) : []),
    ...folds(req.orderId),
  ]);
  const order = await getOrderView(req.orderId);
  return order ? { ok: true, order } : { ok: false, reason: "not_found" };
}
