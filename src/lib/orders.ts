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
  const placed: HistoryEntry = { at: o.placedAt, who: name(o.createdBy), approvedBy: null, text: `Placed (${CHANNEL_LABEL[o.channel]})` };
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
  // Placed leads even when a line's fire stamp sorts a few ms earlier: lines
  // are stamped with the app server's clock, placed_at with the database's.
  return [placed, ...entries.sort((a, b) => a.at.localeCompare(b.at))];
}

// ---------------------------------------------------------------------------
// Reports: one pure fold over a window's facts. A shift report is the sales
// report for the shift's window plus the drawer reconciliation; a day report
// is the sales report for a store-local day.
// ---------------------------------------------------------------------------

export type OrderRef = { id: string; number: number };

/** Dine-in is its own sales line whatever rang it in, like the inbox badge. */
export type SalesChannel = Channel | "dine_in";

export const SALES_CHANNELS: readonly SalesChannel[] = ["walk_in", "phone", "dine_in", "online"];

export const SALES_CHANNEL_LABEL: Record<SalesChannel, string> = {
  walk_in: "Walk-in",
  phone: "Phone",
  dine_in: "Dine-in",
  online: "Online",
};

export const TENDER_METHOD_LABEL: Record<TenderMethod, string> = {
  cash: "Cash",
  card_external: "Card (external terminal)",
};

export type AuditKind = "void" | "comp" | "discount" | "refund" | "no_sale" | "paid_in" | "paid_out";

/** Report sections, in print order. */
export const AUDIT_SECTIONS: readonly { kind: AuditKind; label: string }[] = [
  { kind: "void", label: "Voids" },
  { kind: "comp", label: "Comps" },
  { kind: "discount", label: "Discounts" },
  { kind: "refund", label: "Refunds" },
  { kind: "no_sale", label: "No-sale drawer opens" },
  { kind: "paid_in", label: "Paid in" },
  { kind: "paid_out", label: "Paid out" },
];

/** Every money exception and drawer open, with who did it and who approved it. */
export type AuditEntry = {
  kind: AuditKind;
  at: string;
  /** Null for drawer events, which belong to no order. */
  order: OrderRef | null;
  /** The line, for voids and line comps/discounts. */
  item: string | null;
  cents: number;
  employeeId: number | null;
  approvedBy: number | null;
  reason: string | null;
};

/** [from, to); `to` is null while a shift is still open. */
export type ReportWindow = { from: string; to: string | null };

export type ReportFacts = {
  window: ReportWindow;
  /** Names for every employee id in the facts. */
  staff: Record<number, string>;
  tenders: (Pick<Tender, "direction" | "method" | "amountCents" | "tipCents" | "employeeId" | "approvedBy" | "reason" | "at"> & {
    order: OrderRef;
  })[];
  adjustments: (Pick<Adjustment, "kind" | "cents" | "employeeId" | "approvedBy" | "reason" | "at"> & {
    order: OrderRef;
    item: string | null;
  })[];
  voids: { employeeId: number | null; approvedBy: number | null; cents: number; reason: string | null; at: string; order: OrderRef; item: string }[];
  drawerEvents: { kind: DrawerEventKind; cents: number; employeeId: number; approvedBy: number | null; reason: string | null; at: string }[];
  orders: {
    id: string;
    number: number;
    status: KitchenStatus;
    channel: Channel;
    orderType: Fulfillment["kind"];
    placedAt: string;
    customerName: string;
    totals: Totals;
  }[];
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

export type SalesLine = {
  orders: number;
  grossCents: number;
  discountCents: number;
  netCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  /** Gratuity added to online orders; card tips taken at the till are on tenders. */
  tipCents: number;
  totalCents: number;
};

export type MethodTotals = {
  method: TenderMethod;
  payments: number;
  paymentCents: number;
  tipCents: number;
  refundCents: number;
  /** Payments − refunds + tips: what the drawer or the card batch should hold. */
  netCents: number;
};

export type SalesReport = {
  window: ReportWindow;
  staff: Record<number, string>;
  byChannel: ({ channel: SalesChannel } & SalesLine)[];
  sales: SalesLine;
  byMethod: MethodTotals[];
  audit: AuditEntry[];
  byEmployee: EmployeeTally[];
  unpaidOrders: { id: string; number: number; customerName: string; status: KitchenStatus; dueCents: number }[];
  needsRefund: { id: string; number: number; netCents: number }[];
};

export type DrawerReconciliation = {
  expectedCashCents: number;
  countedCashCents: number | null;
  cashOverShortCents: number | null;
  cardTotalCents: number;
  cardTipsCents: number;
  cardBatchCents: number | null;
  cardOverShortCents: number | null;
  declaredCashTipsCents: number | null;
};

export type ShiftReport = SalesReport & DrawerReconciliation;

const emptySales = (): SalesLine => ({
  orders: 0,
  grossCents: 0,
  discountCents: 0,
  netCents: 0,
  taxCents: 0,
  deliveryFeeCents: 0,
  tipCents: 0,
  totalCents: 0,
});

function addSales(into: SalesLine, t: Totals): void {
  into.orders += 1;
  into.grossCents += t.subtotalCents;
  into.discountCents += t.discountCents;
  into.netCents += t.subtotalCents - t.discountCents;
  into.taxCents += t.taxCents;
  into.deliveryFeeCents += t.deliveryFeeCents;
  into.tipCents += t.tipCents;
  into.totalCents += t.totalCents;
}

/**
 * Sales are orders placed in the window and not canceled. Money taken counts
 * every tender in the facts, whenever its order was placed: a pay-at-pickup
 * order placed yesterday is today's cash.
 */
export function salesReport(facts: ReportFacts): SalesReport {
  const channels = new Map(SALES_CHANNELS.map((c) => [c, emptySales()]));
  const sales = emptySales();
  for (const o of facts.orders) {
    const { from, to } = facts.window;
    if (o.status === "canceled" || o.placedAt < from || (to !== null && o.placedAt >= to)) continue;
    addSales(channels.get(o.orderType === "dine_in" ? "dine_in" : o.channel)!, o.totals);
    addSales(sales, o.totals);
  }

  const methods = new Map<TenderMethod, MethodTotals>(
    (["cash", "card_external"] as const).map((method) => [
      method,
      { method, payments: 0, paymentCents: 0, tipCents: 0, refundCents: 0, netCents: 0 },
    ]),
  );
  for (const t of facts.tenders) {
    const m = methods.get(t.method)!;
    if (t.direction === "payment") {
      m.payments += 1;
      m.paymentCents += t.amountCents;
      m.tipCents += t.tipCents;
      m.netCents += t.amountCents + t.tipCents;
    } else {
      m.refundCents += t.amountCents;
      m.netCents -= t.amountCents;
    }
  }

  const audit: AuditEntry[] = [
    ...facts.voids.map((v) => ({ kind: "void" as const, ...v })),
    ...facts.adjustments,
    ...facts.tenders
      .filter((t) => t.direction === "refund")
      .map((t) => ({
        kind: "refund" as const,
        at: t.at,
        order: t.order,
        item: null,
        cents: t.amountCents,
        employeeId: t.employeeId,
        approvedBy: t.approvedBy,
        reason: t.reason,
      })),
    ...facts.drawerEvents.map((e) => ({ ...e, order: null, item: null })),
  ].sort((a, b) => a.at.localeCompare(b.at));

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

  return {
    window: facts.window,
    staff: facts.staff,
    byChannel: SALES_CHANNELS.map((channel) => ({ channel, ...channels.get(channel)! })),
    sales,
    byMethod: [...methods.values()],
    audit,
    byEmployee: [...tallies.values()].sort((a, b) => a.employeeId - b.employeeId),
    unpaidOrders: facts.orders
      .filter((o) => o.status !== "canceled" && dueCents(o.totals) > 0)
      .map((o) => ({ id: o.id, number: o.number, customerName: o.customerName, status: o.status, dueCents: dueCents(o.totals) })),
    needsRefund: facts.orders
      .filter((o) => o.status === "canceled" && o.totals.paidCents - o.totals.refundedCents > 0)
      .map((o) => ({ id: o.id, number: o.number, netCents: o.totals.paidCents - o.totals.refundedCents })),
  };
}

/**
 * expected cash = bank + cash payments − cash refunds + paid in − paid out.
 * Card total includes card tips, because the terminal's batch does.
 */
export function reconcileDrawer(
  shift: ShiftCount,
  facts: {
    tenders: Pick<ReportFacts["tenders"][number], "direction" | "method" | "amountCents" | "tipCents">[];
    drawerEvents: Pick<ReportFacts["drawerEvents"][number], "kind" | "cents">[];
  },
): DrawerReconciliation {
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
  };
}

export function shiftReport(shift: ShiftCount, facts: ReportFacts): ShiftReport {
  return { ...salesReport(facts), ...reconcileDrawer(shift, facts) };
}
