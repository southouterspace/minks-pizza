/**
 * Order domain: the types every screen renders and the pure rules over them
 * (payment state, role policy, activity log, shift report). No I/O; the
 * server seam that reads and writes these lives in orders-server.ts.
 */
import type { KitchenStation } from "@/lib/kds";
import type { LineModifier, Selection } from "@/lib/pricing";

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

export const CHANNEL_LABEL: Record<Channel, string> = {
  online: "Online",
  walk_in: "Walk-in",
  phone: "Phone",
};

/** Badge text: a dine-in check reads as dine-in whatever rang it in. */
export function channelLabel(channel: Channel, orderType: Fulfillment["kind"]): string {
  return orderType === "dine_in" ? "Dine-in" : CHANNEL_LABEL[channel];
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
  const entries: HistoryEntry[] = [
    { at: o.placedAt, who: name(o.createdBy), approvedBy: null, text: `Placed (${CHANNEL_LABEL[o.channel]})` },
  ];
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
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

// ---------------------------------------------------------------------------
// Shift report: the drawer reconciliation, as a pure fold
// ---------------------------------------------------------------------------

export type ShiftFacts = {
  tenders: Pick<Tender, "direction" | "method" | "amountCents" | "tipCents">[];
  adjustments: Pick<Adjustment, "kind" | "cents" | "employeeId" | "approvedBy">[];
  voids: { employeeId: number | null; approvedBy: number | null; cents: number }[];
  drawerEvents: { kind: DrawerEventKind; cents: number; employeeId: number }[];
  orders: { id: string; number: number; status: KitchenStatus; customerName: string; totals: Money }[];
};

export type ShiftCount = {
  startingBankCents: number;
  countedCashCents: number | null;
  cardBatchCents: number | null;
  declaredCashTipsCents: number | null;
};

export type EmployeeTally = {
  employeeId: number;
  voids: number;
  voidCents: number;
  comps: number;
  compCents: number;
  discountCents: number;
  noSales: number;
};

export type ShiftReport = {
  expectedCashCents: number;
  countedCashCents: number | null;
  cashOverShortCents: number | null;
  cardTotalCents: number;
  cardTipsCents: number;
  cardBatchCents: number | null;
  cardOverShortCents: number | null;
  declaredCashTipsCents: number | null;
  byEmployee: EmployeeTally[];
  unpaidOrders: { id: string; number: number; customerName: string; dueCents: number }[];
  needsRefund: { id: string; number: number; netCents: number }[];
};

/**
 * expected cash = bank + cash payments − cash refunds + paid in − paid out.
 * Card total includes card tips, because the terminal's batch does.
 */
export function shiftReport(shift: ShiftCount, facts: ShiftFacts): ShiftReport {
  let cash = shift.startingBankCents;
  let card = 0;
  let cardTips = 0;
  for (const t of facts.tenders) {
    const sign = t.direction === "payment" ? 1 : -1;
    if (t.method === "cash") {
      cash += sign * t.amountCents;
    } else {
      card += sign * (t.amountCents + t.tipCents);
      cardTips += sign * t.tipCents;
    }
  }
  for (const e of facts.drawerEvents) {
    if (e.kind === "paid_in") cash += e.cents;
    if (e.kind === "paid_out") cash -= e.cents;
  }

  const tallies = new Map<number, EmployeeTally>();
  const tally = (id: number) => {
    let t = tallies.get(id);
    if (!t) {
      t = { employeeId: id, voids: 0, voidCents: 0, comps: 0, compCents: 0, discountCents: 0, noSales: 0 };
      tallies.set(id, t);
    }
    return t;
  };
  for (const v of facts.voids) {
    if (v.employeeId === null) continue;
    const t = tally(v.employeeId);
    t.voids += 1;
    t.voidCents += v.cents;
  }
  for (const a of facts.adjustments) {
    const t = tally(a.employeeId);
    if (a.kind === "comp") {
      t.comps += 1;
      t.compCents += a.cents;
    } else {
      t.discountCents += a.cents;
    }
  }
  for (const e of facts.drawerEvents) {
    if (e.kind === "no_sale") tally(e.employeeId).noSales += 1;
  }

  const overShort = (counted: number | null, expected: number) =>
    counted === null ? null : counted - expected;
  return {
    expectedCashCents: cash,
    countedCashCents: shift.countedCashCents,
    cashOverShortCents: overShort(shift.countedCashCents, cash),
    cardTotalCents: card,
    cardTipsCents: cardTips,
    cardBatchCents: shift.cardBatchCents,
    cardOverShortCents: overShort(shift.cardBatchCents, card),
    declaredCashTipsCents: shift.declaredCashTipsCents,
    byEmployee: [...tallies.values()].sort((a, b) => a.employeeId - b.employeeId),
    unpaidOrders: facts.orders
      .filter((o) => o.status !== "canceled" && dueCents(o.totals) > 0)
      .map((o) => ({ id: o.id, number: o.number, customerName: o.customerName, dueCents: dueCents(o.totals) })),
    needsRefund: facts.orders
      .filter((o) => o.status === "canceled" && o.totals.paidCents - o.totals.refundedCents > 0)
      .map((o) => ({ id: o.id, number: o.number, netCents: o.totals.paidCents - o.totals.refundedCents })),
  };
}
