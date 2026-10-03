import { sql, type SQL } from "drizzle-orm";
import { db, orderDiscounts } from "@/db";
import { isForeignKeyViolation } from "@/db/errors";
import { CUSTOMER, type Actor } from "@/lib/order-writes";
import { rejected, type MutationResult, type SubmitOrderRequest } from "@/lib/orders";
import { priceLines } from "@/lib/menu-server";
import type { RedemptionCheck } from "@/lib/promotion-usage";
import { getSettings, policyOf, type Settings } from "@/lib/settings-server";
import { getOpenShift } from "@/lib/drawer-server";
import type { StaffContext } from "@/lib/staff";
import { folds, run, type Statement } from "./folds";
import { actorOf } from "./mutate";
import { getOrderView, getQuote } from "./views";
import {
  addressUpsert,
  customerUpsert,
  firing,
  fulfillmentColumns,
  insertLines,
  placedEvent,
  tenderInsert,
  tenderProblem,
} from "./writes";

/**
 * What the storefront's quote decided, written with the order: the deals and
 * reward as discount rows, the loyalty columns, and the promotion guard the
 * insert runs under (checkout.ts explains the retry).
 */
export type OnlineQuote = {
  discounts: { promotionId: number; codeId: number | null; label: string; amountCents: number; target: "items" | "delivery" }[];
  reward: { name: string; pointsCost: number; discountCents: number } | null;
  memberId: number | null;
  pointsEarned: number;
  check: RedemptionCheck;
  /** Enrollment and redemption statements; each writes nothing when the order row is missing. */
  after: (orderId: string) => Statement[];
};

export type Submitter = { kind: "pos"; staff: StaffContext } | { kind: "online"; quote: OnlineQuote };

/** The promotion guard refused the order after the quote: a deal's limit went to another order. */
export class DealChangedError extends Error {}

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

const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * Prices on the server and writes the whole order in one batch. Replaying
 * the same request returns the stored order without writing anything.
 * Store-open, fulfillment and minimum checks apply to online orders only;
 * the counter can always ring an order in. An online order is inserted
 * under its promotion guard after the promotions lock: when the guard
 * misses, nothing is written and DealChangedError says so.
 */
export async function submitOrder(req: SubmitOrderRequest, by: Submitter): Promise<MutationResult> {
  const [existing, settings, drawer] = await Promise.all([getOrderView(req.orderId), getSettings(), getOpenShift()]);
  if (existing) return { ok: true, order: existing };

  if (by.kind === "online") {
    if (req.source !== "web" || req.tenders.length > 0) return rejected("Invalid online order.");
    const closed = onlineGate(req, settings);
    if (closed) return rejected(closed);
  } else if (req.source === "web") {
    return rejected("The counter rings in walk-in and phone orders.");
  }
  if (req.lines.length === 0) return rejected("The order has no items.");

  const [priced, quote] = await Promise.all([priceLines(req.lines, policyOf(settings)), getQuote(settings)]);
  if (!Array.isArray(priced)) return priced;
  const subtotal = priced.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
  if (by.kind === "online" && req.fulfillment.kind === "delivery" && subtotal < settings.deliveryMinimumCents) {
    return rejected(`Delivery orders have a minimum subtotal of $${(settings.deliveryMinimumCents / 100).toFixed(2)}.`);
  }

  if (req.tenders.length > 0) {
    const problem = req.tenders.map(tenderProblem).find((p) => p !== null);
    if (problem) return rejected(problem);
    if (!drawer) return { ok: false, reason: "no_open_shift" };
  }

  const now = new Date();
  const { fireNow, fireAt } = firing(req.fire, now);
  const quoted = req.fulfillment.kind === "delivery" ? quote.deliveryMinutes : quote.pickupMinutes;
  const promisedAt = req.promisedAt
    ? new Date(req.promisedAt)
    : new Date((fireAt ?? now).getTime() + quoted * 60_000);

  const customer = req.customer ? customerUpsert(req.customer) : null;
  const actor: Actor = by.kind === "pos" ? actorOf(by.staff) : CUSTOMER;
  const online = by.kind === "online" ? by.quote : null;
  const reward = online?.reward ?? null;
  const f = fulfillmentColumns(req.fulfillment, settings);
  const guard: SQL = online ? online.check.guard : sql`true`;

  const orderInsert = db.execute(sql`
    insert into orders (id, source, status, order_type, address_line1, address_line2, city, zip, table_label,
      delivery_fee_cents, customer_id, customer_name, customer_phone, customer_email, order_notes, created_by,
      fire_at, promised_at, tip_cents, tax_rate_bps,
      loyalty_member_id, loyalty_reward_name, loyalty_points_redeemed, loyalty_points_earned)
    select ${req.orderId}::uuid, ${req.source}::order_source, 'held'::order_status, ${f.orderType}::order_type,
      ${f.addressLine1}, ${f.addressLine2}, ${f.city}, ${f.zip}, ${f.tableLabel},
      ${f.deliveryFeeCents}::integer, ${customer ? customer.id : sql`null::uuid`},
      ${req.customer?.name ?? (req.fulfillment.kind === "dine_in" ? `Table ${req.fulfillment.table}` : "Walk-in")},
      ${req.customer?.phone ?? ""}, ${req.customer?.email ?? null}, ${req.notes}, ${actor.employeeId}::integer,
      ${iso(fireAt)}::timestamptz, ${promisedAt.toISOString()}::timestamptz, ${req.tipCents}::integer,
      ${settings.taxRateBps}::integer,
      ${online?.memberId ?? null}::integer, ${reward?.name ?? null}, ${reward?.pointsCost ?? 0}::integer,
      ${online?.pointsEarned ?? 0}::integer
    where ${guard}
    on conflict (id) do nothing`);

  const discountRows: (typeof orderDiscounts.$inferInsert)[] = [
    ...(online?.discounts ?? []).map((a) => ({
      orderId: req.orderId,
      promotionId: a.promotionId,
      codeId: a.codeId,
      label: a.label,
      amountCents: a.amountCents,
      target: a.target,
      source: "promotion" as const,
    })),
    ...(reward && reward.discountCents > 0
      ? [{ orderId: req.orderId, label: reward.name, amountCents: reward.discountCents, target: "items" as const, source: "loyalty" as const }]
      : []),
  ];

  const statements: Statement[] = [
    ...(online ? [db.execute(online.check.lock)] : []),
    ...(customer ? [customer.statement] : []),
    ...(customer && req.customer?.saveAddress ? addressUpsert(customer.id, req.fulfillment) : []),
    orderInsert,
    // The first child after the order: a guard miss makes this insert fail
    // its foreign key, which rolls the batch back and is how we learn of it.
    ...insertLines(req.orderId, priced, fireNow),
    ...(discountRows.length ? [db.insert(orderDiscounts).values(discountRows)] : []),
    placedEvent(req.orderId, actor),
    ...(online ? online.after(req.orderId) : []),
    ...(drawer ? req.tenders.map((t) => tenderInsert(req.orderId, t, drawer.id, actor.employeeId)) : []),
    ...(await folds(req.orderId, actor)),
  ];
  try {
    await run(statements);
  } catch (err) {
    if (online && isForeignKeyViolation(err)) throw new DealChangedError("A deal on your order just changed.");
    throw err;
  }
  const order = await getOrderView(req.orderId);
  return order ? { ok: true, order } : { ok: false, reason: "not_found" };
}
