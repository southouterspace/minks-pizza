/** Order reads: the views every POS, admin and storefront screen renders. */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { customerAddresses, customers, db, orderDiscounts, orderEvents, orderItems, orders } from "@/db";
import type { OrderStatus } from "@/lib/order-workflow";
import { normalizePhone, type Board, type CustomerLookup, type OrderView, type Quote } from "@/lib/orders";
import { quoteMinutes } from "@/lib/pricing";
import { getSettings, type Settings } from "@/lib/settings-server";
import { getOpenShift } from "@/lib/drawer-server";
import { fireDue } from "./folds";
import { fulfillmentOf, staffNames, totalsOf } from "./rows";

const withFacts = {
  items: true as const,
  tenders: true as const,
  discounts: { orderBy: [asc(orderDiscounts.id)] },
  events: { orderBy: [asc(orderEvents.createdAt), asc(orderEvents.id)] },
};
type OrderRow = NonNullable<Awaited<ReturnType<typeof findOrder>>>;

function findOrder(id: string) {
  return db.query.orders.findFirst({ where: eq(orders.id, id), with: withFacts });
}

async function toViews(rows: OrderRow[]): Promise<OrderView[]> {
  const staff = await staffNames(
    rows.flatMap((o) => [
      o.createdBy,
      ...o.items.flatMap((i) => [i.voidedBy, i.voidApprovedBy]),
      ...o.tenders.flatMap((t) => [t.employeeId, t.approvedBy]),
      ...o.discounts.flatMap((d) => [d.employeeId, d.approvedBy]),
      ...o.events.flatMap((e) => [e.employeeId, e.approvedBy]),
    ]),
  );
  return rows.map((o) => toView(o, staff));
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

function toView(o: OrderRow, staff: Record<number, string>): OrderView {
  return {
    id: o.id,
    number: o.orderNumber,
    ticketOrderId: o.ticketOrderId ?? o.id,
    status: o.status,
    source: o.source,
    fulfillment: fulfillmentOf(o),
    customer: { id: o.customerId, name: o.customerName, phone: o.customerPhone, email: o.customerEmail },
    notes: o.orderNotes,
    placedAt: o.placedAt.toISOString(),
    fireAt: iso(o.fireAt),
    promisedAt: iso(o.promisedAt),
    readyAt: iso(o.readyAt),
    createdBy: o.createdBy,
    lines: o.items
      .toSorted((a, b) => a.id - b.id)
      .map((i) => ({
        lineId: i.lineUid,
        itemId: i.menuItemId,
        name: i.itemName,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
        lineTotalCents: i.lineTotalCents,
        modifiers: i.modifiers,
        notes: i.notes,
        station: i.station,
        firedAt: iso(i.firedAt),
        ovenAt: iso(i.ovenAt),
        doneAt: iso(i.doneAt),
        voided: i.voidedAt
          ? { at: i.voidedAt.toISOString(), by: i.voidedBy, reason: i.voidReason ?? "", approvedBy: i.voidApprovedBy }
          : null,
      })),
    tenders: o.tenders
      .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((t) => ({
        id: t.id,
        direction: t.direction,
        method: t.method,
        amountCents: t.amountCents,
        tenderedCents: t.tenderedCents,
        tipCents: t.tipCents,
        last4: t.last4,
        employeeId: t.employeeId,
        approvedBy: t.approvedBy,
        reason: t.reason,
        at: t.createdAt.toISOString(),
      })),
    discounts: o.discounts.map((d) => ({
      id: d.id,
      uid: d.uid,
      lineId: d.lineUid,
      label: d.label,
      amountCents: d.amountCents,
      target: d.target,
      source: d.source,
      employeeId: d.employeeId,
      approvedBy: d.approvedBy,
      operatorId: d.operatorId,
      at: d.createdAt.toISOString(),
    })),
    events: o.events.map((e) => ({
      id: e.id,
      type: e.type,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      actor: e.actor,
      employeeId: e.employeeId,
      approvedBy: e.approvedBy,
      note: e.note,
      at: e.createdAt.toISOString(),
    })),
    totals: totalsOf(o),
    staff,
  };
}

export async function getOrderView(id: string): Promise<OrderView | null> {
  const row = await findOrder(id);
  return row ? (await toViews([row]))[0] : null;
}

/** Orders in these kitchen states, newest first, for the admin inbox. */
export async function listOrderViews(statuses: OrderStatus[]): Promise<OrderView[]> {
  return toViews(
    await db.query.orders.findMany({
      where: inArray(orders.status, statuses),
      with: withFacts,
      orderBy: [desc(orders.placedAt)],
    }),
  );
}

export async function getQuote(s: Settings): Promise<Quote> {
  const [row] = await db
    .select({ pies: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int` })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        inArray(orders.status, ["new", "preparing"]),
        eq(orderItems.station, "pizza"),
        sql`${orderItems.firedAt} is not null`,
        isNull(orderItems.voidedAt),
        isNull(orderItems.doneAt),
      ),
    );
  const piesAhead = row?.pies ?? 0;
  const pickupMinutes = quoteMinutes({
    piesAhead,
    ovenCapacityPies: s.ovenCapacityPies,
    ovenMinutes: s.kdsOvenMinutes,
    makeMinutes: s.makeMinutes,
    baseMinutes: s.pickupPrepMinutes,
  });
  const deliveryExtra = Math.max(0, s.deliveryPrepMinutes - s.pickupPrepMinutes);
  return { pickupMinutes, deliveryMinutes: pickupMinutes + deliveryExtra, piesAhead };
}

/** The POS board poll. Also fires any scheduled order that has come due. */
export async function getBoard(): Promise<Board> {
  const now = new Date();
  await fireDue(now);
  const [rows, quote, shift] = await Promise.all([
    db.query.orders.findMany({
      where: inArray(orders.status, ["held", "new", "preparing", "ready"]),
      with: withFacts,
      orderBy: [asc(orders.placedAt)],
    }),
    getSettings().then(getQuote),
    getOpenShift(),
  ]);
  return {
    serverNow: now.toISOString(),
    openOrders: await toViews(rows),
    quote,
    shift: shift ? { id: shift.id, openedAt: shift.openedAt.toISOString(), openedBy: shift.openedBy } : null,
  };
}

export async function lookupCustomer(phone: string): Promise<CustomerLookup> {
  const [customer] = await db.select().from(customers).where(eq(customers.phone, normalizePhone(phone)));
  if (!customer) return { customer: null, addresses: [], recentOrders: [] };
  const [addresses, rows] = await Promise.all([
    db
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, customer.id))
      .orderBy(desc(customerAddresses.lastUsedAt))
      .limit(5),
    db.query.orders.findMany({
      where: eq(orders.customerId, customer.id),
      with: withFacts,
      orderBy: [desc(orders.placedAt)],
      limit: 5,
    }),
  ]);
  return {
    customer: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email, notes: customer.notes },
    addresses: addresses.map((a) => ({ id: a.id, line1: a.line1, line2: a.line2, city: a.city, zip: a.zip })),
    recentOrders: await toViews(rows),
  };
}
