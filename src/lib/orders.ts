/**
 * Order domain: the types every screen renders and the pure rules over them
 * (payment state, role policy, activity log) and the wire contract the POS
 * and storefront share with the server. No I/O; the server seam that reads
 * and writes these lives in orders-server/.
 */
import type { KitchenStation } from "@/lib/kds";
import type { LineModifier, MenuItem, PricingPolicy, Selection } from "@/lib/pricing";

export type KitchenStatus = "held" | "new" | "preparing" | "ready" | "completed" | "canceled";
export type Channel = "online" | "walk_in" | "phone";
export type EmployeeRole = "cashier" | "manager" | "owner";
export type TenderMethod = "cash" | "card_external";
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

export type Actor = { employeeId: number; name: string; role: EmployeeRole };

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

export type Adjustment = {
  id: string;
  /** Null = the whole check. */
  lineId: string | null;
  kind: "discount" | "comp";
  cents: number;
  reason: string;
  employeeId: number;
  approvedBy: number | null;
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
  status: KitchenStatus;
  channel: Channel;
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
  adjustments: Adjustment[];
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

/** Dine-in is its own channel whatever rang it in: on badges, in the activity log and in reports. */
export type SalesChannel = Channel | "dine_in";

export const SALES_CHANNELS: readonly SalesChannel[] = ["walk_in", "phone", "dine_in", "online"];

export const SALES_CHANNEL_LABEL: Record<SalesChannel, string> = {
  walk_in: "Walk-in",
  phone: "Phone",
  dine_in: "Dine-in",
  online: "Online",
};

export function salesChannel(channel: Channel, kind: Fulfillment["kind"]): SalesChannel {
  return kind === "dine_in" ? "dine_in" : channel;
}

export function channelLabel(channel: Channel, kind: Fulfillment["kind"]): string {
  return SALES_CHANNEL_LABEL[salesChannel(channel, kind)];
}

/** "Dine-in, table 4", "Phone, delivery", "Walk-in": where an order came from and how it leaves. */
export function sourceLabel(channel: Channel, f: Fulfillment): string {
  if (f.kind === "dine_in") return f.table ? `Dine-in, table ${f.table}` : "Dine-in";
  return channel === "walk_in" && f.kind === "pickup" ? "Walk-in" : `${SALES_CHANNEL_LABEL[channel]}, ${f.kind}`;
}

/** "Pepperoni (left half)", "extra Onions", "Size: Large 14\"". */
export function modifierLabel(m: LineModifier): string {
  if (m.kind === "option") return `${m.groupName}: ${m.modifierName}`;
  const amount = m.amount === "regular" ? "" : `${m.amount} `;
  const half = m.placement === "whole" ? "" : ` (${m.placement} half)`;
  return `${amount}${m.modifierName}${half}`;
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
  | { kind: "discount"; id: string; lineId: string | null; cents: number; reason: string }
  | { kind: "comp"; id: string; lineId: string; reason: string }
  | { kind: "tender"; tender: TenderInput }
  | { kind: "refund"; id: string; method: TenderMethod; amountCents: number; reason: string }
  | { kind: "set_customer"; customer: CustomerInput }
  | { kind: "set_fulfillment"; fulfillment: Fulfillment }
  | { kind: "set_schedule"; fire: FirePlan; promisedAt: string | null }
  | { kind: "cancel"; reason: string }
  | { kind: "split_by_item"; lineIds: string[]; newOrderId: string }
  | { kind: "handoff" };

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

export function roleSatisfies(role: EmployeeRole, required: RequiredRole): boolean {
  return required === "cashier" || role === "manager" || role === "owner";
}

// ---------------------------------------------------------------------------
// The wire contract: what the POS, the storefront and the server seam exchange
// ---------------------------------------------------------------------------

export type SubmitOrderRequest = {
  orderId: string;
  channel: Channel;
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

export const rejected = (message: string): Rejected => ({ ok: false, reason: "rejected", message });

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

/** "+1 (555) 010-2233" → "5550102233". The customers table keys on this. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
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

export function orderHistory(o: OrderView): HistoryEntry[] {
  const name = (id: number | null) => (id === null ? null : (o.staff[id] ?? `#${id}`));
  const lineName = (lineId: string | null) => {
    const line = o.lines.find((l) => l.lineId === lineId);
    return line ? `${line.quantity} × ${line.name}` : "the check";
  };
  const placed: HistoryEntry = { at: o.placedAt, who: name(o.createdBy), approvedBy: null, text: `Placed (${sourceLabel(o.channel, o.fulfillment)})` };
  const entries: HistoryEntry[] = [];
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
  for (const a of o.adjustments) {
    const verb = a.kind === "comp" ? "Comped" : "Discounted";
    entries.push({
      at: a.at,
      who: name(a.employeeId),
      approvedBy: name(a.approvedBy),
      text: `${verb} ${lineName(a.lineId)} by ${(a.cents / 100).toFixed(2)} (${a.reason})`,
    });
  }
  for (const t of o.tenders) {
    const method = t.method === "cash" ? "cash" : "card";
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
  return [placed, ...entries.sort((a, b) => a.at.localeCompare(b.at))];
}
