/**
 * The order seam: every write to an order goes through submitOrder or
 * mutateOrder. Each write is one db.batch of convergent statements (inserts
 * keyed by client-minted UUIDs with ON CONFLICT DO NOTHING, coalesce stamps)
 * followed by the folds that derive money and kitchen status, so a replayed
 * or half-retried write lands on the same end state.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  adjustments,
  categories,
  customerAddresses,
  customers,
  db,
  drawerEvents,
  employees,
  itemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
  orderItems,
  orders,
  shifts,
  storeSettings,
  tenders,
} from "@/db";
import {
  DRAWER_ROLE,
  dueCents,
  requiredRole,
  roleSatisfies,
  shiftReport,
  type Approval,
  type Channel,
  type CustomerInput,
  type DrawerEventKind,
  type FirePlan,
  type Fulfillment,
  type KitchenStatus,
  type OrderMutation,
  type OrderView,
  type ReportFacts,
  type RequiredRole,
  type ShiftReport,
  type SubmitLine,
  type TenderInput,
} from "@/lib/orders";
import {
  PricingError,
  priceLine,
  quoteMinutes,
  type MenuItem,
  type PricingPolicy,
} from "@/lib/pricing";
import { checkPin } from "@/lib/pin";
import { DEFAULT_TIMEZONE } from "@/lib/store-time";
import type { StaffContext } from "@/lib/staff";

type Statement = BatchItem<"pg">;

export type Failure =
  | { ok: false; reason: "needs_manager" }
  | { ok: false; reason: "bad_pin" }
  | { ok: false; reason: "locked_out" }
  | { ok: false; reason: "no_open_shift" }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "rejected"; message: string };

export type MutationResult = { ok: true; order: OrderView } | Failure;

const rejected = (message: string): Failure => ({ ok: false, reason: "rejected", message });

export class StoreNotConfiguredError extends Error {}

export async function getSettings() {
  const [settings] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
  if (!settings) throw new StoreNotConfiguredError("Store is not configured yet.");
  return settings;
}

type Settings = Awaited<ReturnType<typeof getSettings>>;

/** Name and timezone for admin pages, which render before the store is configured. */
export async function getStoreBasics(): Promise<{ name: string; timezone: string }> {
  const [row] = await db
    .select({ name: storeSettings.name, timezone: storeSettings.timezone })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  return row ?? { name: "My Pizzeria", timezone: DEFAULT_TIMEZONE };
}

function policyOf(s: Settings): PricingPolicy {
  return { halfToppingRule: s.halfToppingRule, extraToppingBps: s.extraToppingBps };
}

/** "+1 (555) 010-2233" → "5550102233". The customers table keys on this. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

async function loadMenuItems(itemIds?: number[]): Promise<(MenuItem & { categoryId: number })[]> {
  if (itemIds?.length === 0) return [];
  const rows = await db
    .select({ item: menuItems, station: categories.station })
    .from(menuItems)
    .innerJoin(categories, eq(categories.id, menuItems.categoryId))
    .where(itemIds ? inArray(menuItems.id, itemIds) : eq(categories.isActive, true))
    .orderBy(asc(menuItems.sortOrder), asc(menuItems.id));
  const ids = rows.map((r) => r.item.id);
  const links = ids.length
    ? await db
        .select()
        .from(itemModifierGroups)
        .where(inArray(itemModifierGroups.itemId, ids))
        .orderBy(asc(itemModifierGroups.sortOrder), asc(itemModifierGroups.id))
    : [];
  const groupIds = [...new Set(links.map((l) => l.groupId))];
  const [groups, mods] = groupIds.length
    ? await Promise.all([
        db.select().from(modifierGroups).where(inArray(modifierGroups.id, groupIds)),
        db
          .select()
          .from(modifiers)
          .where(inArray(modifiers.groupId, groupIds))
          .orderBy(asc(modifiers.sortOrder), asc(modifiers.id)),
      ])
    : [[], []];
  const groupById = new Map(groups.map((g) => [g.id, g]));

  return rows.map(({ item, station }) => ({
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    description: item.description,
    basePriceCents: item.basePriceCents,
    isAvailable: item.isAvailable,
    station,
    groups: links
      .filter((l) => l.itemId === item.id)
      .flatMap((l) => {
        const g = groupById.get(l.groupId);
        if (!g) return [];
        return [
          {
            id: g.id,
            name: g.name,
            role: g.role,
            minSelect: g.minSelect,
            maxSelect: g.maxSelect,
            modifiers: mods
              .filter((m) => m.groupId === g.id)
              .map((m) => ({
                id: m.id,
                name: m.name,
                priceDeltaCents: m.priceDeltaCents,
                isDefault: m.isDefault,
                isAvailable: m.isAvailable,
              })),
          },
        ];
      }),
  }));
}

export type PosMenu = {
  /** Changes whenever anything that affects entry or pricing changes. */
  version: string;
  policy: PricingPolicy;
  taxRateBps: number;
  deliveryFeeCents: number;
  discountApprovalCents: number;
  categories: { id: number; name: string; items: MenuItem[] }[];
};

export async function getPosMenu(): Promise<PosMenu> {
  const [settings, items, cats] = await Promise.all([
    getSettings(),
    loadMenuItems(),
    db.select().from(categories).where(eq(categories.isActive, true)).orderBy(asc(categories.sortOrder)),
  ]);
  const body = {
    policy: policyOf(settings),
    taxRateBps: settings.taxRateBps,
    deliveryFeeCents: settings.deliveryFeeCents,
    discountApprovalCents: settings.discountApprovalCents,
    categories: cats.map((c) => ({
      id: c.id,
      name: c.name,
      items: items.filter((i) => i.categoryId === c.id),
    })),
  };
  const version = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { version, ...body };
}

type PricedLine = SubmitLine & {
  name: string;
  station: MenuItem["station"];
  unitPriceCents: number;
  modifiers: ReturnType<typeof priceLine>["modifiers"];
};

async function priceLines(lines: SubmitLine[], policy: PricingPolicy): Promise<PricedLine[] | Failure> {
  const items = new Map(
    (await loadMenuItems([...new Set(lines.map((l) => l.itemId))])).map((i) => [i.id, i]),
  );
  try {
    return lines.map((line) => {
      const item = items.get(line.itemId);
      if (!item) throw new PricingError("An item in this order is no longer on the menu.");
      const priced = priceLine(item, line.selections, policy);
      return { ...line, name: item.name, station: item.station, ...priced };
    });
  } catch (err) {
    if (err instanceof PricingError) return rejected(err.message);
    throw err;
  }
}

function insertLines(orderId: string, lines: PricedLine[], firedAt: Date | null): Statement[] {
  if (lines.length === 0) return [];
  return [
    db
      .insert(orderItems)
      .values(
        lines.map((l) => ({
          lineUid: l.lineId,
          orderId,
          menuItemId: l.itemId,
          itemName: l.name,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          lineTotalCents: l.unitPriceCents * l.quantity,
          modifiers: l.modifiers,
          notes: l.notes,
          station: l.station,
          firedAt,
        })),
      )
      .onConflictDoNothing({ target: orderItems.lineUid }),
  ];
}

// ---------------------------------------------------------------------------
// Folds: the only writers of orders' money columns and kitchen status
// ---------------------------------------------------------------------------

function recomputeTotals(orderId: string): Statement {
  return db.execute(sql`
    update orders o set
      subtotal_cents = f.subtotal,
      discount_cents = f.discount,
      tax_cents = f.tax,
      total_cents = f.subtotal - f.discount + f.tax + o.delivery_fee_cents + o.tip_cents,
      paid_cents = f.paid,
      refunded_cents = f.refunded,
      updated_at = now()
    from (
      select x.subtotal, least(x.subtotal, x.adjusted) as discount,
        round((x.subtotal - least(x.subtotal, x.adjusted)) * r.tax_rate_bps / 10000.0)::int as tax,
        x.paid, x.refunded
      from orders r, (
        select
          coalesce((select sum(i.line_total_cents) from order_items i
                    where i.order_id = ${orderId} and i.voided_at is null), 0)::int as subtotal,
          coalesce((select sum(a.cents) from adjustments a
                    where a.order_id = ${orderId}
                      and (a.line_uid is null or exists (
                        select 1 from order_items i
                        where i.line_uid = a.line_uid and i.order_id = ${orderId} and i.voided_at is null))), 0)::int as adjusted,
          coalesce((select sum(t.amount_cents) from tenders t
                    where t.order_id = ${orderId} and t.direction = 'payment'), 0)::int as paid,
          coalesce((select sum(t.amount_cents) from tenders t
                    where t.order_id = ${orderId} and t.direction = 'refund'), 0)::int as refunded
      ) x
      where r.id = ${orderId}
    ) f
    where o.id = ${orderId}`);
}

/**
 * Kitchen status from line stamps. held → new once a live line is fired;
 * new → preparing once one is touched; → ready once every fired live line
 * that needs cooking is done; ready/completed → new when lines are fired
 * onto the check after it was ready. Canceled is terminal and only `cancel`
 * sets it.
 */
export function syncStatus(orderId: string): Statement[] {
  const fired = sql`exists (select 1 from order_items i where i.order_id = ${orderId}
    and i.fired_at is not null and i.voided_at is null)`;
  const pending = sql`exists (select 1 from order_items i where i.order_id = ${orderId}
    and i.fired_at is not null and i.voided_at is null and i.station <> 'counter' and i.done_at is null)`;
  const firedSinceReady = sql`exists (select 1 from order_items i where i.order_id = ${orderId}
    and i.fired_at > ${orders.readyAt} and i.voided_at is null and i.station <> 'counter'
    and i.done_at is null)`;
  const touched = sql`exists (select 1 from order_items i where i.order_id = ${orderId}
    and i.voided_at is null and (i.oven_at is not null or i.done_at is not null))`;
  return [
    db
      .update(orders)
      .set({ status: "new", updatedAt: sql`now()` })
      .where(and(eq(orders.id, orderId), eq(orders.status, "held"), fired)),
    db
      .update(orders)
      .set({ status: "new", readyAt: null, updatedAt: sql`now()` })
      .where(and(eq(orders.id, orderId), inArray(orders.status, ["ready", "completed"]), firedSinceReady)),
    db
      .update(orders)
      .set({ status: "preparing", updatedAt: sql`now()` })
      .where(and(eq(orders.id, orderId), eq(orders.status, "new"), touched)),
    db
      .update(orders)
      .set({ status: "ready", readyAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(eq(orders.id, orderId), inArray(orders.status, ["new", "preparing"]), fired, sql`not ${pending}`),
      ),
  ];
}

function folds(orderId: string): Statement[] {
  return [recomputeTotals(orderId), ...syncStatus(orderId)];
}

async function run(statements: Statement[]): Promise<void> {
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const withFacts = { items: true, tenders: true, adjustments: true } as const;
type OrderRow = NonNullable<Awaited<ReturnType<typeof findOrder>>>;

function findOrder(id: string) {
  return db.query.orders.findFirst({ where: eq(orders.id, id), with: withFacts });
}

async function toViews(rows: OrderRow[]): Promise<OrderView[]> {
  const ids = new Set<number>();
  for (const o of rows) {
    if (o.createdBy !== null) ids.add(o.createdBy);
    for (const i of o.items) for (const id of [i.voidedBy, i.voidApprovedBy]) if (id !== null) ids.add(id);
    for (const t of o.tenders) for (const id of [t.employeeId, t.approvedBy]) if (id !== null) ids.add(id);
    for (const a of o.adjustments) for (const id of [a.employeeId, a.approvedBy]) if (id !== null) ids.add(id);
  }
  const staff = ids.size
    ? Object.fromEntries(
        (await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, [...ids]))).map(
          (e) => [e.id, e.name],
        ),
      )
    : {};
  return rows.map((o) => toView(o, staff));
}

function fulfillmentOf(o: OrderRow): Fulfillment {
  switch (o.orderType) {
    case "pickup":
      return { kind: "pickup" };
    case "delivery":
      return {
        kind: "delivery",
        address: { line1: o.addressLine1 ?? "", line2: o.addressLine2, city: o.city, zip: o.zip ?? "" },
      };
    case "dine_in":
      return { kind: "dine_in", table: o.tableLabel ?? "" };
  }
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

function toView(o: OrderRow, staff: Record<number, string>): OrderView {
  return {
    id: o.id,
    number: o.orderNumber,
    ticketOrderId: o.ticketOrderId ?? o.id,
    status: o.status,
    channel: o.channel,
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
    adjustments: o.adjustments
      .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((a) => ({
        id: a.id,
        lineId: a.lineUid,
        kind: a.kind,
        cents: a.cents,
        reason: a.reason,
        employeeId: a.employeeId,
        approvedBy: a.approvedBy,
        at: a.createdAt.toISOString(),
      })),
    totals: {
      subtotalCents: o.subtotalCents,
      discountCents: o.discountCents,
      taxCents: o.taxCents,
      deliveryFeeCents: o.deliveryFeeCents,
      tipCents: o.tipCents,
      totalCents: o.totalCents,
      paidCents: o.paidCents,
      refundedCents: o.refundedCents,
    },
    staff,
  };
}

export async function getOrderView(id: string): Promise<OrderView | null> {
  const row = await findOrder(id);
  return row ? (await toViews([row]))[0] : null;
}

/** Orders in these kitchen states, newest first, for the admin inbox. */
export async function listOrderViews(statuses: KitchenStatus[]): Promise<OrderView[]> {
  return toViews(
    await db.query.orders.findMany({
      where: inArray(orders.status, statuses),
      with: withFacts,
      orderBy: [desc(orders.placedAt)],
    }),
  );
}

export async function getOpenShift() {
  const [shift] = await db.select().from(shifts).where(isNull(shifts.closedAt));
  return shift ?? null;
}

export type Quote = { pickupMinutes: number; deliveryMinutes: number; piesAhead: number };

export async function getQuote(settings?: Settings): Promise<Quote> {
  const s = settings ?? (await getSettings());
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

export type Board = {
  serverNow: string;
  /** Held (scheduled or open checks) and on-the-line orders, oldest first. */
  openOrders: OrderView[];
  quote: Quote;
  shift: { id: string; openedAt: string; openedBy: number } | null;
};

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
    getQuote(),
    getOpenShift(),
  ]);
  return {
    serverNow: now.toISOString(),
    openOrders: await toViews(rows),
    quote,
    shift: shift ? { id: shift.id, openedAt: shift.openedAt.toISOString(), openedBy: shift.openedBy } : null,
  };
}

export type CustomerLookup = {
  customer: { id: string; name: string; phone: string; email: string | null; notes: string | null } | null;
  addresses: { id: string; line1: string; line2: string | null; city: string | null; zip: string }[];
  recentOrders: OrderView[];
};

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

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

/**
 * Who approved a gated action: the actor when their own role suffices, else
 * the manager whose PIN came with the request. Null when no gate applies.
 */
async function authorize(
  required: RequiredRole,
  staff: StaffContext,
  approval: Approval | undefined,
): Promise<{ ok: true; approvedBy: number | null } | Failure> {
  if (required === "cashier") return { ok: true, approvedBy: null };
  if (roleSatisfies(staff.actor.role, required)) return { ok: true, approvedBy: staff.actor.employeeId };
  if (!approval) return { ok: false, reason: "needs_manager" };
  const check = await checkPin(approval.managerPin, staff.operatorId);
  if (!check.ok) return { ok: false, reason: check.reason };
  if (!roleSatisfies(check.actor.role, required)) return { ok: false, reason: "needs_manager" };
  return { ok: true, approvedBy: check.actor.employeeId };
}

// ---------------------------------------------------------------------------
// Submit
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

function customerUpsert(c: CustomerInput): { statement: Statement; id: SQL } {
  const phone = normalizePhone(c.phone);
  return {
    statement: db
      .insert(customers)
      .values({ phone, name: c.name, email: c.email, lastOrderAt: sql`now()` })
      .onConflictDoUpdate({
        target: customers.phone,
        set: {
          name: sql`excluded.name`,
          email: sql`coalesce(excluded.email, ${customers.email})`,
          lastOrderAt: sql`now()`,
        },
      }),
    id: sql`(select id from customers where phone = ${phone})`,
  };
}

function addressUpsert(customerId: SQL, f: Fulfillment): Statement[] {
  if (f.kind !== "delivery") return [];
  const a = f.address;
  return [
    db
      .insert(customerAddresses)
      .values({ customerId, line1: a.line1, line2: a.line2, city: a.city, zip: a.zip })
      .onConflictDoUpdate({
        target: [customerAddresses.customerId, customerAddresses.line1, customerAddresses.zip],
        set: { line2: sql`excluded.line2`, city: sql`excluded.city`, lastUsedAt: sql`now()` },
      }),
  ];
}

function fulfillmentColumns(f: Fulfillment, s: Settings) {
  switch (f.kind) {
    case "pickup":
      return { orderType: f.kind, addressLine1: null, addressLine2: null, city: null, zip: null, tableLabel: null, deliveryFeeCents: 0 };
    case "delivery":
      return {
        orderType: f.kind,
        addressLine1: f.address.line1,
        addressLine2: f.address.line2,
        city: f.address.city,
        zip: f.address.zip,
        tableLabel: null,
        deliveryFeeCents: s.deliveryFeeCents,
      };
    case "dine_in":
      return { orderType: f.kind, addressLine1: null, addressLine2: null, city: null, zip: null, tableLabel: f.table, deliveryFeeCents: 0 };
  }
}

function tenderInsert(orderId: string, t: TenderInput, shiftId: string, employeeId: number): Statement {
  return db
    .insert(tenders)
    .values({
      id: t.id,
      orderId,
      shiftId,
      direction: "payment",
      method: t.method,
      amountCents: t.amountCents,
      tenderedCents: t.method === "cash" ? (t.tenderedCents ?? t.amountCents) : null,
      tipCents: t.tipCents,
      last4: t.last4,
      employeeId,
    })
    .onConflictDoNothing({ target: tenders.id });
}

function tenderProblem(t: TenderInput): string | null {
  if (t.amountCents <= 0) return "A payment must be more than zero.";
  if (t.method === "cash" && t.tenderedCents !== null && t.tenderedCents < t.amountCents) {
    return "Cash handed over is less than the amount applied.";
  }
  return null;
}

/** When a fire plan sends lines to the kitchen, and when a held order fires itself. */
function firing(plan: FirePlan, now: Date): { firedAt: Date | null; fireAt: Date | null } {
  switch (plan.kind) {
    case "now":
      return { firedAt: now, fireAt: null };
    case "hold":
      return { firedAt: null, fireAt: null };
    case "at": {
      const at = new Date(plan.at);
      return at <= now ? { firedAt: now, fireAt: null } : { firedAt: null, fireAt: at };
    }
  }
}

/**
 * Prices on the server and writes the whole order in one batch. Replaying
 * the same request returns the stored order without writing anything.
 * Store-open, fulfillment and minimum checks apply to online orders only;
 * the counter can always ring an order in.
 */
export async function submitOrder(req: SubmitOrderRequest, by: Submitter): Promise<MutationResult> {
  const existing = await getOrderView(req.orderId);
  if (existing) return { ok: true, order: existing };

  const settings = await getSettings();
  if (by.kind === "online") {
    if (req.channel !== "online" || req.tenders.length > 0) return rejected("Invalid online order.");
    const closed = onlineGate(req, settings);
    if (closed) return rejected(closed);
  } else if (req.channel === "online") {
    return rejected("The counter rings in walk-in and phone orders.");
  }
  if (req.lines.length === 0) return rejected("The order has no items.");

  const priced = await priceLines(req.lines, policyOf(settings));
  if (!Array.isArray(priced)) return priced;
  const subtotal = priced.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
  if (by.kind === "online" && req.fulfillment.kind === "delivery" && subtotal < settings.deliveryMinimumCents) {
    return rejected(`Delivery orders have a minimum subtotal of $${(settings.deliveryMinimumCents / 100).toFixed(2)}.`);
  }

  let shiftId: string | null = null;
  if (req.tenders.length > 0 && by.kind === "pos") {
    const problem = req.tenders.map(tenderProblem).find((p) => p !== null);
    if (problem) return rejected(problem);
    shiftId = (await getOpenShift())?.id ?? null;
    if (!shiftId) return { ok: false, reason: "no_open_shift" };
  }

  const now = new Date();
  const { firedAt, fireAt } = firing(req.fire, now);
  const quote = await getQuote(settings);
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
    ...insertLines(req.orderId, priced, firedAt),
    ...(shiftId !== null && staffId !== null ? req.tenders.map((t) => tenderInsert(req.orderId, t, shiftId, staffId)) : []),
    ...folds(req.orderId),
  ]);
  const order = await getOrderView(req.orderId);
  return order ? { ok: true, order } : { ok: false, reason: "not_found" };
}

// ---------------------------------------------------------------------------
// Mutate
// ---------------------------------------------------------------------------

type Plan = { statements: Statement[]; alsoFold?: string } | Failure;

const liveLine = (o: OrderView, lineId: string) => o.lines.find((l) => l.lineId === lineId && !l.voided);

async function plan(
  m: OrderMutation,
  order: OrderView,
  actor: StaffContext["actor"],
  approvedBy: number | null,
  settings: Settings,
): Promise<Plan> {
  const id = order.id;
  const now = new Date();
  switch (m.kind) {
    case "add_lines": {
      const priced = await priceLines(m.lines, policyOf(settings));
      if (!Array.isArray(priced)) return priced;
      return { statements: insertLines(id, priced, m.fire ? now : null) };
    }
    case "fire":
      return {
        statements: [
          db
            .update(orderItems)
            .set({ firedAt: sql`coalesce(${orderItems.firedAt}, ${now})` })
            .where(
              and(
                eq(orderItems.orderId, id),
                isNull(orderItems.voidedAt),
                m.lineIds === "all" ? undefined : inArray(orderItems.lineUid, m.lineIds),
              ),
            ),
        ],
      };
    case "void_line": {
      if (!order.lines.some((l) => l.lineId === m.lineId)) return rejected("That line is not on this order.");
      return {
        statements: [
          db
            .update(orderItems)
            .set({
              voidedAt: sql`coalesce(${orderItems.voidedAt}, ${now})`,
              voidedBy: sql`coalesce(${orderItems.voidedBy}, ${actor.employeeId})`,
              voidReason: sql`coalesce(${orderItems.voidReason}, ${m.reason})`,
              voidApprovedBy: sql`coalesce(${orderItems.voidApprovedBy}, ${approvedBy})`,
            })
            .where(and(eq(orderItems.orderId, id), eq(orderItems.lineUid, m.lineId))),
        ],
      };
    }
    case "discount":
    case "comp": {
      if (order.adjustments.some((a) => a.id === m.id)) return { statements: [] };
      const line = m.lineId === null ? null : liveLine(order, m.lineId);
      if (m.lineId !== null && !line) return rejected("That line is not on this order.");
      const cents = m.kind === "comp" ? line!.lineTotalCents : m.cents;
      if (cents <= 0) return rejected("A discount must be more than zero.");
      return {
        statements: [
          db
            .insert(adjustments)
            .values({
              id: m.id,
              orderId: id,
              lineUid: m.lineId,
              kind: m.kind,
              cents,
              reason: m.reason,
              employeeId: actor.employeeId,
              approvedBy,
            })
            .onConflictDoNothing({ target: adjustments.id }),
        ],
      };
    }
    case "tender": {
      if (order.tenders.some((t) => t.id === m.tender.id)) return { statements: [] };
      const problem = tenderProblem(m.tender);
      if (problem) return rejected(problem);
      if (m.tender.amountCents > dueCents(order.totals)) return rejected("That is more than the balance due.");
      const shift = await getOpenShift();
      if (!shift) return { ok: false, reason: "no_open_shift" };
      return { statements: [tenderInsert(id, m.tender, shift.id, actor.employeeId)] };
    }
    case "refund": {
      if (order.tenders.some((t) => t.id === m.id)) return { statements: [] };
      const net = order.totals.paidCents - order.totals.refundedCents;
      if (m.amountCents <= 0 || m.amountCents > net) return rejected("A refund can't exceed what was paid.");
      const shift = await getOpenShift();
      if (!shift) return { ok: false, reason: "no_open_shift" };
      return {
        statements: [
          db
            .insert(tenders)
            .values({
              id: m.id,
              orderId: id,
              shiftId: shift.id,
              direction: "refund",
              method: m.method,
              amountCents: m.amountCents,
              employeeId: actor.employeeId,
              approvedBy,
              reason: m.reason,
            })
            .onConflictDoNothing({ target: tenders.id }),
        ],
      };
    }
    case "set_customer": {
      const c = customerUpsert(m.customer);
      return {
        statements: [
          c.statement,
          ...(m.customer.saveAddress ? addressUpsert(c.id, order.fulfillment) : []),
          db
            .update(orders)
            .set({ customerId: c.id, customerName: m.customer.name, customerPhone: m.customer.phone, customerEmail: m.customer.email })
            .where(eq(orders.id, id)),
        ],
      };
    }
    case "set_fulfillment":
      return {
        statements: [db.update(orders).set(fulfillmentColumns(m.fulfillment, settings)).where(eq(orders.id, id))],
      };
    case "set_schedule": {
      if (order.status !== "held") return rejected("This order is already in the kitchen.");
      const { firedAt, fireAt } = firing(m.fire, now);
      const promisedAt = m.promisedAt ? new Date(m.promisedAt) : null;
      return {
        statements: [
          db.update(orders).set({ fireAt, promisedAt: promisedAt ?? sql`${orders.promisedAt}` }).where(eq(orders.id, id)),
          ...(firedAt
            ? [
                db
                  .update(orderItems)
                  .set({ firedAt: sql`coalesce(${orderItems.firedAt}, ${firedAt})` })
                  .where(and(eq(orderItems.orderId, id), isNull(orderItems.voidedAt))),
              ]
            : []),
        ],
      };
    }
    case "cancel":
      return {
        statements: [
          db
            .update(orderItems)
            .set({
              voidedAt: sql`coalesce(${orderItems.voidedAt}, ${now})`,
              voidedBy: sql`coalesce(${orderItems.voidedBy}, ${actor.employeeId})`,
              voidReason: sql`coalesce(${orderItems.voidReason}, ${m.reason})`,
              voidApprovedBy: sql`coalesce(${orderItems.voidApprovedBy}, ${approvedBy})`,
            })
            .where(eq(orderItems.orderId, id)),
          db
            .update(orders)
            .set({ status: "canceled", deliveryFeeCents: 0, tipCents: 0, updatedAt: sql`now()` })
            .where(eq(orders.id, id)),
        ],
      };
    case "split_by_item": {
      if ((await getOrderView(m.newOrderId)) !== null) return { statements: [] };
      const moving = new Set(m.lineIds);
      const live = order.lines.filter((l) => !l.voided);
      if (m.lineIds.length === 0 || m.lineIds.some((l) => !liveLine(order, l))) {
        return rejected("Pick lines on this order to split off.");
      }
      if (live.every((l) => moving.has(l.lineId))) return rejected("Leave at least one line on the original check.");
      return {
        alsoFold: m.newOrderId,
        statements: [
          db.execute(sql`
            insert into orders (id, status, order_type, channel, table_label, customer_id, customer_name,
              customer_phone, customer_email, address_line1, address_line2, city, zip, order_notes,
              created_by, fire_at, promised_at, ticket_order_id, placed_at, tax_rate_bps)
            select ${m.newOrderId}, status, order_type, channel, table_label, customer_id, customer_name,
              customer_phone, customer_email, address_line1, address_line2, city, zip, order_notes,
              ${actor.employeeId}, fire_at, promised_at, coalesce(ticket_order_id, id), placed_at, tax_rate_bps
            from orders where id = ${id}
            on conflict (id) do nothing`),
          db
            .update(orderItems)
            .set({ orderId: m.newOrderId })
            .where(and(eq(orderItems.orderId, id), inArray(orderItems.lineUid, m.lineIds))),
          db
            .update(adjustments)
            .set({ orderId: m.newOrderId })
            .where(and(eq(adjustments.orderId, id), inArray(adjustments.lineUid, m.lineIds))),
        ],
      };
    }
    case "handoff":
      if (order.status !== "ready") return rejected("Only a ready order can be handed off.");
      return {
        statements: [
          db
            .update(orders)
            .set({ status: "completed", updatedAt: sql`now()` })
            .where(and(eq(orders.id, id), eq(orders.status, "ready"))),
        ],
      };
  }
}

/**
 * Applies one POS verb. The role policy runs here, against the order as it
 * is now; when it needs a manager and the actor isn't one, the result is
 * `needs_manager` and the client resends the same input with `approval`.
 */
export async function mutateOrder(
  input: { orderId: string; mutation: OrderMutation; approval?: Approval },
  staff: StaffContext,
): Promise<MutationResult> {
  const order = await getOrderView(input.orderId);
  if (!order) return { ok: false, reason: "not_found" };
  const m = input.mutation;
  if (order.status === "canceled" && m.kind !== "refund") return rejected("This order is canceled.");

  const settings = await getSettings();
  const auth = await authorize(
    requiredRole(m, { order, discountApprovalCents: settings.discountApprovalCents }),
    staff,
    input.approval,
  );
  if (!auth.ok) return auth;

  const p = await plan(m, order, staff.actor, auth.approvedBy, settings);
  if ("ok" in p) return p;
  if (p.statements.length > 0) {
    await run([...p.statements, ...folds(order.id), ...(p.alsoFold ? folds(p.alsoFold) : [])]);
  }
  const fresh = await getOrderView(order.id);
  return fresh ? { ok: true, order: fresh } : { ok: false, reason: "not_found" };
}

/**
 * Fires every held order whose fire time has come. Runs on each KDS and POS
 * board poll, so scheduled orders fire whenever any screen is open.
 */
export async function fireDue(now: Date): Promise<number> {
  const due = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, "held"), lte(orders.fireAt, now)));
  if (due.length === 0) return 0;
  const ids = due.map((d) => d.id);
  await run([
    db
      .update(orderItems)
      .set({ firedAt: sql`coalesce(${orderItems.firedAt}, ${now})` })
      .where(and(inArray(orderItems.orderId, ids), isNull(orderItems.voidedAt))),
    ...ids.flatMap(folds),
  ]);
  return ids.length;
}

// ---------------------------------------------------------------------------
// Shifts and the drawer
// ---------------------------------------------------------------------------

export type ShiftResult = { ok: true; shiftId: string } | Failure;

export async function openShift(
  input: { shiftId: string; startingBankCents: number },
  staff: StaffContext,
): Promise<ShiftResult> {
  await db
    .insert(shifts)
    .values({ id: input.shiftId, openedBy: staff.actor.employeeId, startingBankCents: input.startingBankCents })
    .onConflictDoNothing();
  const open = await getOpenShift();
  return open?.id === input.shiftId ? { ok: true, shiftId: open.id } : rejected("Another shift is already open.");
}

/**
 * The window a report covers. A shift's money is its own tenders and drawer
 * events (only one shift is open at a time, so its window holds nothing
 * else); a day's is everything stamped inside the day.
 */
export type ReportScope =
  | { kind: "shift"; shiftId: string; from: Date; to: Date | null }
  | { kind: "day"; from: Date; to: Date };

/** [from, to), or open-ended while a shift is still open. */
function within(col: Parameters<typeof gte>[0], scope: ReportScope) {
  return and(gte(col, scope.from), scope.to ? lt(col, scope.to) : undefined);
}

/** The tenders a report counts. */
export function tendersIn(scope: ReportScope) {
  return scope.kind === "shift" ? eq(tenders.shiftId, scope.shiftId) : within(tenders.createdAt, scope);
}

/** Ids of every order a report covers: placed in the window, or paid or refunded in it. */
export function reportOrderIds(scope: ReportScope) {
  const tendered = db.select({ id: tenders.orderId }).from(tenders).where(tendersIn(scope));
  return db
    .select({ id: orders.id })
    .from(orders)
    .where(or(within(orders.placedAt, scope), inArray(orders.id, tendered)));
}

export async function loadReportFacts(scope: ReportScope): Promise<ReportFacts> {
  const ref = { id: orders.id, number: orders.orderNumber };
  const lineName = sql<string>`${orderItems.quantity} || ' × ' || ${orderItems.itemName}`;
  const [tenderRows, drawerRows, adjustmentRows, voidRows, orderRows] = await Promise.all([
    db
      .select({ t: tenders, order: ref })
      .from(tenders)
      .innerJoin(orders, eq(orders.id, tenders.orderId))
      .where(tendersIn(scope)),
    db
      .select()
      .from(drawerEvents)
      .where(scope.kind === "shift" ? eq(drawerEvents.shiftId, scope.shiftId) : within(drawerEvents.createdAt, scope)),
    db
      .select({ a: adjustments, order: ref, item: lineName })
      .from(adjustments)
      .innerJoin(orders, eq(orders.id, adjustments.orderId))
      .leftJoin(orderItems, eq(orderItems.lineUid, adjustments.lineUid))
      .where(within(adjustments.createdAt, scope)),
    db
      .select({ i: orderItems, order: ref, item: lineName })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(within(orderItems.voidedAt, scope)),
    db.select().from(orders).where(inArray(orders.id, reportOrderIds(scope))),
  ]);

  const ids = new Set<number>();
  const note = (...xs: (number | null)[]) => xs.forEach((x) => x !== null && ids.add(x));
  tenderRows.forEach(({ t }) => note(t.employeeId, t.approvedBy));
  drawerRows.forEach((e) => note(e.employeeId, e.approvedBy));
  adjustmentRows.forEach(({ a }) => note(a.employeeId, a.approvedBy));
  voidRows.forEach(({ i }) => note(i.voidedBy, i.voidApprovedBy));
  const staff = ids.size
    ? Object.fromEntries(
        (await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, [...ids]))).map(
          (e) => [e.id, e.name],
        ),
      )
    : {};

  return {
    window: { from: scope.from.toISOString(), to: scope.to?.toISOString() ?? null },
    staff,
    tenders: tenderRows.map(({ t, order }) => ({
      direction: t.direction,
      method: t.method,
      amountCents: t.amountCents,
      tipCents: t.tipCents,
      employeeId: t.employeeId,
      approvedBy: t.approvedBy,
      reason: t.reason,
      at: t.createdAt.toISOString(),
      order,
    })),
    adjustments: adjustmentRows.map(({ a, order, item }) => ({
      kind: a.kind,
      cents: a.cents,
      employeeId: a.employeeId,
      approvedBy: a.approvedBy,
      reason: a.reason,
      at: a.createdAt.toISOString(),
      order,
      item,
    })),
    voids: voidRows.map(({ i, order, item }) => ({
      employeeId: i.voidedBy,
      approvedBy: i.voidApprovedBy,
      cents: i.lineTotalCents,
      reason: i.voidReason,
      at: i.voidedAt!.toISOString(),
      order,
      item,
    })),
    drawerEvents: drawerRows.map((e) => ({
      kind: e.kind,
      cents: e.cents,
      employeeId: e.employeeId,
      approvedBy: e.approvedBy,
      reason: e.reason,
      at: e.createdAt.toISOString(),
    })),
    orders: orderRows.map((o) => ({
      id: o.id,
      number: o.orderNumber,
      status: o.status,
      channel: o.channel,
      orderType: o.orderType,
      placedAt: o.placedAt.toISOString(),
      customerName: o.customerName,
      totals: {
        subtotalCents: o.subtotalCents,
        discountCents: o.discountCents,
        taxCents: o.taxCents,
        deliveryFeeCents: o.deliveryFeeCents,
        tipCents: o.tipCents,
        totalCents: o.totalCents,
        paidCents: o.paidCents,
        refundedCents: o.refundedCents,
      },
    })),
  };
}

export async function getShiftReport(shiftId: string): Promise<ShiftReport | null> {
  const [shift] = await db.select().from(shifts).where(eq(shifts.id, shiftId));
  if (!shift) return null;
  const facts = await loadReportFacts({
    kind: "shift",
    shiftId,
    from: shift.openedAt,
    to: shift.closedAt,
  });
  return shiftReport(shift, facts);
}

export async function closeShift(
  input: {
    shiftId: string;
    countedCashCents: number;
    cardBatchCents: number;
    declaredCashTipsCents: number;
    notes: string | null;
    approval?: Approval;
  },
  staff: StaffContext,
): Promise<{ ok: true; report: ShiftReport } | Failure> {
  const auth = await authorize("manager", staff, input.approval);
  if (!auth.ok) return auth;
  await db
    .update(shifts)
    .set({
      closedAt: sql`now()`,
      closedBy: auth.approvedBy,
      countedCashCents: input.countedCashCents,
      cardBatchCents: input.cardBatchCents,
      declaredCashTipsCents: input.declaredCashTipsCents,
      notes: input.notes,
    })
    .where(and(eq(shifts.id, input.shiftId), isNull(shifts.closedAt)));
  const report = await getShiftReport(input.shiftId);
  return report ? { ok: true, report } : { ok: false, reason: "not_found" };
}

export async function recordDrawerEvent(
  input: { id: string; kind: DrawerEventKind; cents: number; reason: string | null; approval?: Approval },
  staff: StaffContext,
): Promise<{ ok: true } | Failure> {
  const auth = await authorize(DRAWER_ROLE[input.kind], staff, input.approval);
  if (!auth.ok) return auth;
  const shift = await getOpenShift();
  if (!shift) return { ok: false, reason: "no_open_shift" };
  await db
    .insert(drawerEvents)
    .values({
      id: input.id,
      shiftId: shift.id,
      kind: input.kind,
      cents: input.kind === "no_sale" ? 0 : input.cents,
      reason: input.reason,
      employeeId: staff.actor.employeeId,
      approvedBy: auth.approvedBy,
    })
    .onConflictDoNothing({ target: drawerEvents.id });
  return { ok: true };
}
