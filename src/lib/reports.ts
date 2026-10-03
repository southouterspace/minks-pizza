/**
 * Reports: one pure fold over a window's facts. A shift report is the sales
 * report for the shift's window plus the drawer reconciliation; a day report
 * is the sales report for a store-local day. No I/O; reports-server.ts loads
 * the facts.
 */
import {
  SALES_CHANNELS,
  dueCents,
  salesChannel,
  type Adjustment,
  type Channel,
  type DrawerEventKind,
  type Fulfillment,
  type KitchenStatus,
  type SalesChannel,
  type Tender,
  type TenderMethod,
  type Totals,
} from "@/lib/orders";

/**
 * The window a report covers. A shift's money is its own tenders and drawer
 * events (only one shift is open at a time, so its window holds nothing
 * else); a day's is everything stamped inside the day.
 */
export type ReportScope =
  | { kind: "shift"; shiftId: string; from: Date; to: Date | null }
  | { kind: "day"; from: Date; to: Date };

export type OrderRef = { id: string; number: number };

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
    addSales(channels.get(salesChannel(o.channel, o.orderType))!, o.totals);
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
