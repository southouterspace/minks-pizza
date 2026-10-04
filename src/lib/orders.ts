/**
 * Order domain: the types every screen renders and the pure rules over them
 * (payment state, role policy, activity log) and the wire contract the POS
 * and storefront share with the server. No I/O; the server seam that reads
 * and writes these lives in orders-server/.
 */
import type { OrderSource } from "@/lib/delivery/types";
import type { KitchenStation } from "@/lib/kds";
import { describeEvent, type OrderEventType, type OrderStatus } from "@/lib/order-workflow";
import { type PosAccess, roleSatisfies } from "@/lib/pos-access";
import type { LineModifier, MenuItem, PricingPolicy, Selection } from "@/lib/pricing";
import type { DiscountSource, DiscountTarget } from "@/lib/promotion-schema";

export type { OrderSource };

/** Where the store's own orders come from; marketplace orders arrive through ingestion. */
export type StoreSource = Extract<OrderSource, "web" | "walk_in" | "phone">;

export const MARKETPLACE_SOURCES: readonly OrderSource[] = ["doordash", "ubereats", "grubhub"];

export const TENDER_METHODS = ["cash", "card_external", "other", "marketplace"] as const;
export type TenderMethod = (typeof TENDER_METHODS)[number];
export const TENDER_METHOD_LABEL: Record<TenderMethod, string> = {
  cash: "Cash",
  card_external: "Card",
  other: "Other",
  marketplace: "Marketplace",
};
export type DrawerEventKind = "no_sale" | "paid_in" | "paid_out";

export type Address = {
  line1: string;
  line2: string | null;
  city: string | null;
  zip: string;
};

/** An address cannot exist on a pickup; a table cannot exist on a delivery. */
export type Fulfillment =
  | { kind: "pickup" }
  | { kind: "delivery"; address: Address }
  | { kind: "dine_in"; table: string };

/** The employee at the terminal, as the role policy and the audit trail see them. */
export type StaffActor = { employeeId: number; name: string; access: PosAccess };

export type LineView = {
  /** The line_uid: what the POS addresses a line by. */
  lineId: string;
  itemId: number | null;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  modifiers: LineModifier[];
  notes: string | null;
  station: KitchenStation;
  firedAt: string | null;
  ovenAt: string | null;
  doneAt: string | null;
  voided: null | { at: string; by: number | null; reason: string; approvedBy: number | null };
};

export type Tender = {
  id: string;
  direction: "payment" | "refund";
  method: TenderMethod;
  amountCents: number;
  tenderedCents: number | null;
  tipCents: number;
  last4: string | null;
  employeeId: number | null;
  approvedBy: number | null;
  reason: string | null;
  at: string;
};

/** One order_discounts row: a promotion, a loyalty reward, or a staff comp or discount. */
export type Discount = {
  id: number;
  /** Client-minted at the POS; null for promotion and loyalty rows. */
  uid: string | null;
  /** Set on a comp of one line; null = the check. */
  lineId: string | null;
  label: string;
  amountCents: number;
  target: DiscountTarget;
  source: DiscountSource;
  employeeId: number | null;
  approvedBy: number | null;
  operatorId: number | null;
  at: string;
};

/** One order_events row: a status move, an ETA push, an operator note. */
export type OrderEvent = {
  id: number;
  type: OrderEventType;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  actor: string;
  employeeId: number | null;
  approvedBy: number | null;
  note: string | null;
  at: string;
};

export type Totals = {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  tipCents: number;
  totalCents: number;
  paidCents: number;
  refundedCents: number;
};

export type OrderView = {
  id: string;
  number: number;
  /** The KDS ticket this order rides on: its own id unless split off another. */
  ticketOrderId: string;
  status: OrderStatus;
  source: OrderSource;
  fulfillment: Fulfillment;
  customer: { id: string | null; name: string; phone: string; email: string | null };
  notes: string | null;
  placedAt: string;
  fireAt: string | null;
  promisedAt: string | null;
  readyAt: string | null;
  createdBy: number | null;
  lines: LineView[];
  tenders: Tender[];
  discounts: Discount[];
  events: OrderEvent[];
  totals: Totals;
  /** Names for every employee id above, for the activity log. */
  staff: Record<number, string>;
};

// ---------------------------------------------------------------------------
// Payment state: derived from the ledger folds, never stored
// ---------------------------------------------------------------------------

export type PaymentState = "unpaid" | "partial" | "paid" | "refunded";
type Money = Pick<Totals, "totalCents" | "paidCents" | "refundedCents">;

export function paymentState(t: Money): PaymentState {
  const net = t.paidCents - t.refundedCents;
  if (t.refundedCents > 0 && net < t.totalCents) return "refunded";
  if (net >= t.totalCents && t.paidCents > 0) return "paid";
  if (net > 0) return "partial";
  return t.totalCents === 0 ? "paid" : "unpaid";
}

export function dueCents(t: Money): number {
  return Math.max(0, t.totalCents - (t.paidCents - t.refundedCents));
}

export const PAYMENT_LABEL: Record<PaymentState, string> = {
  unpaid: "Unpaid",
  partial: "Part paid",
  paid: "Paid",
  refunded: "Refunded",
};

/**
 * Dine-in is its own channel whatever rang it in, and the three marketplaces
 * are one: on badges, in the activity log and in reports.
 */
export type SalesChannel = StoreSource | "dine_in" | "marketplace";

export const SALES_CHANNELS: readonly SalesChannel[] = ["walk_in", "phone", "dine_in", "web", "marketplace"];

export const SALES_CHANNEL_LABEL: Record<SalesChannel, string> = {
  walk_in: "Walk-in",
  phone: "Phone",
  dine_in: "Dine-in",
  web: "Online",
  marketplace: "Marketplace",
};

export const SOURCE_LABEL: Record<OrderSource, string> = {
  web: "Online",
  walk_in: "Walk-in",
  phone: "Phone",
  doordash: "DoorDash",
  ubereats: "Uber Eats",
  grubhub: "Grubhub",
};

export function salesChannel(source: OrderSource, kind: Fulfillment["kind"]): SalesChannel {
  if (kind === "dine_in") return "dine_in";
  return MARKETPLACE_SOURCES.includes(source) ? "marketplace" : (source as StoreSource);
}

export function channelLabel(source: OrderSource, kind: Fulfillment["kind"]): string {
  return kind === "dine_in" ? SALES_CHANNEL_LABEL.dine_in : SOURCE_LABEL[source];
}

/** "1 Main St, Apt 2, The Woodlands, 77354". */
export function formatAddress(a: Address): string {
  return [a.line1, a.line2, a.city, a.zip].filter(Boolean).join(", ");
}

export const FULFILLMENT_LABEL: Record<Fulfillment["kind"], string> = {
  pickup: "Pickup",
  delivery: "Delivery",
  dine_in: "Dine-in",
};

/** "Pickup", "Delivery", "Dine-in · Table 4". */
export function fulfillmentLabel(f: Fulfillment): string {
  return f.kind === "dine_in" ? `${FULFILLMENT_LABEL.dine_in} · Table ${f.table}` : FULFILLMENT_LABEL[f.kind];
}

/** "Dine-in, table 4", "Phone, delivery", "Walk-in", "DoorDash, pickup": where an order came from and how it leaves. */
export function sourceLabel(source: OrderSource, f: Fulfillment): string {
  if (f.kind === "dine_in") return `Dine-in, table ${f.table}`;
  return source === "walk_in" && f.kind === "pickup" ? "Walk-in" : `${SOURCE_LABEL[source]}, ${f.kind}`;
}

// ---------------------------------------------------------------------------
// Mutations and the role policy
// ---------------------------------------------------------------------------

export type SubmitLine = {
  lineId: string;
  itemId: number;
  quantity: number;
  selections: Selection[];
  notes: string | null;
};

export type TenderInput = {
  id: string;
  method: TenderMethod;
  amountCents: number;
  /** Cash only: what the customer handed over. */
  tenderedCents: number | null;
  tipCents: number;
  last4: string | null;
};

export type CustomerInput = {
  phone: string;
  name: string;
  email: string | null;
  saveAddress: boolean;
};

export type FirePlan = { kind: "now" } | { kind: "hold" } | { kind: "at"; at: string };

/** Every POS verb against an existing order. One union, one handler. */
export type OrderMutation =
  | { kind: "add_lines"; lines: SubmitLine[]; fire: boolean }
  | { kind: "fire"; lineIds: string[] | "all" }
  | { kind: "void_line"; lineId: string; reason: string }
  | { kind: "discount"; id: string; lineId: string | null; cents: number; reason: string; promotionId?: number | null }
  | { kind: "comp"; id: string; lineId: string; reason: string }
  | { kind: "remove_discount"; discountId: number }
  | { kind: "tender"; tender: TenderInput }
  | { kind: "refund"; id: string; method: TenderMethod; amountCents: number; reason: string }
  | { kind: "set_customer"; customer: CustomerInput }
  | { kind: "set_fulfillment"; fulfillment: Fulfillment }
  | { kind: "set_schedule"; fire: FirePlan; promisedAt: string | null }
  | { kind: "cancel"; reason: string }
  | { kind: "split_by_item"; lineIds: string[]; newOrderId: string }
  | { kind: "handoff" };

/**
 * The fact row a mutation creates, keyed by a client-minted id, when it
 * creates one. A replay of that fact is a no-op.
 */
export function factId(m: OrderMutation): string | null {
  switch (m.kind) {
    case "discount":
    case "comp":
    case "refund":
      return m.id;
    case "tender":
      return m.tender.id;
    case "split_by_item":
      return m.newOrderId;
    case "add_lines":
    case "fire":
    case "void_line":
    case "remove_discount":
    case "set_customer":
    case "set_fulfillment":
    case "set_schedule":
    case "cancel":
    case "handoff":
      return null;
  }
}

export function hasFact(o: OrderView, id: string): boolean {
  return o.discounts.some((d) => d.uid === id) || o.tenders.some((t) => t.id === id);
}

export type Approval = { managerPin: string };

export type RequiredRole = "cashier" | "manager";

export type PolicyContext = {
  order: { lines: Pick<LineView, "lineId" | "firedAt" | "voided">[] };
  discountApprovalCents: number;
};

/**
 * Who may perform a mutation, decided on the server at the moment of the
 * action. A sent (fired) line costs food, so voiding it needs a manager.
 */
export function requiredRole(m: OrderMutation, ctx: PolicyContext): RequiredRole {
  switch (m.kind) {
    case "void_line": {
      const line = ctx.order.lines.find((l) => l.lineId === m.lineId);
      return line?.firedAt ? "manager" : "cashier";
    }
    case "cancel":
      return ctx.order.lines.some((l) => l.firedAt && !l.voided) ? "manager" : "cashier";
    case "discount":
      return m.cents > ctx.discountApprovalCents ? "manager" : "cashier";
    case "comp":
    case "remove_discount":
    case "refund":
      return "manager";
    case "add_lines":
    case "fire":
    case "tender":
    case "set_customer":
    case "set_fulfillment":
    case "set_schedule":
    case "split_by_item":
    case "handoff":
      return "cashier";
  }
}

export const DRAWER_ROLE: Record<DrawerEventKind, RequiredRole> = {
  no_sale: "manager",
  paid_in: "cashier",
  paid_out: "manager",
};

export { roleSatisfies };

// ---------------------------------------------------------------------------
// The wire contract: what the POS, the storefront and the server seam exchange
// ---------------------------------------------------------------------------

export type SubmitOrderRequest = {
  orderId: string;
  source: StoreSource;
  fulfillment: Fulfillment;
  customer: CustomerInput | null;
  notes: string | null;
  fire: FirePlan;
  promisedAt: string | null;
  /** Online gratuity added to the order total; POS card tips ride on tenders. */
  tipCents: number;
  lines: SubmitLine[];
  tenders: TenderInput[];
};

export type Rejected = { ok: false; reason: "rejected"; message: string };

export type Failure =
  | { ok: false; reason: "needs_manager" | "bad_pin" | "locked_out" | "no_open_shift" | "not_found" }
  | Rejected;

export type FailureReason = Failure["reason"];

/** The terminal's unlock has lapsed: show the PIN pad. */
export type Locked = { ok: false; reason: "locked" };

/**
 * Every way a POS action can fail, as the terminal sees it: the seam's
 * refusals, the lock, and the two the client finds out for itself.
 */
export type ActionFailure = Failure | Locked | { ok: false; reason: "signed_out" | "offline" };

export const rejected = (message: string): Rejected => ({ ok: false, reason: "rejected", message });

/** The store never delivers alcohol, so an online order with any is picked up. */
export const ALCOHOL_PICKUP_ONLY = "Alcohol is pickup only. Remove it or switch to pickup.";

export type MutationResult = { ok: true; order: OrderView } | Failure;

export type ShiftResult = { ok: true; shiftId: string } | Failure;

export type PosMenu = {
  /** Changes whenever anything that affects entry or pricing changes. */
  version: string;
  policy: PricingPolicy;
  taxRateBps: number;
  deliveryFeeCents: number;
  discountApprovalCents: number;
  categories: { id: number; name: string; items: MenuItem[] }[];
};

export type Quote = { pickupMinutes: number; deliveryMinutes: number; piesAhead: number };

export type Board = {
  serverNow: string;
  /** Held (scheduled or open checks) and on-the-line orders, oldest first. */
  openOrders: OrderView[];
  quote: Quote;
  shift: { id: string; openedAt: string; openedBy: number } | null;
};

export type CustomerLookup = {
  customer: { id: string; name: string; phone: string; email: string | null; notes: string | null } | null;
  addresses: { id: string; line1: string; line2: string | null; city: string | null; zip: string }[];
  recentOrders: OrderView[];
};

export const digitsOf = (s: string) => s.replace(/\D/g, "");

/** "+1 (555) 010-2233" → "5550102233". The customers table keys on this. */
export function normalizePhone(raw: string): string {
  const digits = digitsOf(raw);
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

// ---------------------------------------------------------------------------
// Activity log: a read-time union over the order's facts
// ---------------------------------------------------------------------------

export type HistoryEntry = {
  at: string;
  who: string | null;
  approvedBy: string | null;
  text: string;
};

/**
 * The activity log: status moves, ETA pushes and notes come from order_events;
 * fires, voids, discounts and tenders are read off their own rows.
 */
export function orderHistory(o: OrderView): HistoryEntry[] {
  const name = (id: number | null) => (id === null ? null : (o.staff[id] ?? `#${id}`));
  const lineName = (lineId: string | null) => {
    const line = o.lines.find((l) => l.lineId === lineId);
    return line ? `${line.quantity} × ${line.name}` : "the check";
  };
  const placedText = `Placed (${sourceLabel(o.source, o.fulfillment)})`;
  const entries: HistoryEntry[] = [];
  for (const e of o.events) {
    const text = e.type === "placed" ? placedText : e.note ? `${describeEvent(e)}: ${e.note}` : describeEvent(e);
    entries.push({ at: e.at, who: e.actor, approvedBy: name(e.approvedBy), text });
  }
  // Orders inserted before the placed event existed get one from their row.
  const placed: HistoryEntry[] = o.events.some((e) => e.type === "placed")
    ? []
    : [{ at: o.placedAt, who: name(o.createdBy), approvedBy: null, text: placedText }];
  const firedAt = [...new Set(o.lines.flatMap((l) => (l.firedAt ? [l.firedAt] : [])))];
  for (const at of firedAt) {
    const fired = o.lines.filter((l) => l.firedAt === at);
    entries.push({ at, who: null, approvedBy: null, text: `Sent to kitchen: ${fired.map((l) => `${l.quantity} × ${l.name}`).join(", ")}` });
  }
  for (const l of o.lines) {
    if (!l.voided) continue;
    entries.push({
      at: l.voided.at,
      who: name(l.voided.by),
      approvedBy: name(l.voided.approvedBy),
      text: `Voided ${l.quantity} × ${l.name} (${l.voided.reason})`,
    });
  }
  for (const d of o.discounts) {
    const text =
      d.source === "comp"
        ? `${d.lineId ? "Comped" : "Discounted"} ${lineName(d.lineId)} by ${(d.amountCents / 100).toFixed(2)} (${d.label})`
        : `${d.source === "loyalty" ? "Reward" : "Deal"}: ${d.label} (−${(d.amountCents / 100).toFixed(2)})`;
    entries.push({ at: d.at, who: name(d.employeeId), approvedBy: name(d.approvedBy), text });
  }
  for (const t of o.tenders) {
    const method = TENDER_METHOD_LABEL[t.method].toLowerCase();
    const amount = (t.amountCents / 100).toFixed(2);
    entries.push({
      at: t.at,
      who: name(t.employeeId),
      approvedBy: name(t.approvedBy),
      text:
        t.direction === "payment"
          ? `Paid ${amount} ${method}${t.tipCents > 0 ? ` + ${(t.tipCents / 100).toFixed(2)} tip` : ""}`
          : `Refunded ${amount} ${method} (${t.reason ?? "no reason"})`,
    });
  }
  // Placed leads even though lines fired with the order share its placed_at
  // stamp (both are the database's now() for the submit batch).
  const sorted = entries.sort((a, b) => a.at.localeCompare(b.at));
  const first = sorted.findIndex((e) => e.text === placedText);
  return first > 0 ? [sorted[first], ...sorted.filter((_, i) => i !== first)] : [...placed, ...sorted];
}
