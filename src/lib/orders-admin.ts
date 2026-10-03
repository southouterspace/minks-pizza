import "server-only";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import { db, orderEvents, orders, storeSettings } from "@/db";
import {
  ACTIVE_STATUSES,
  canTransition,
  isLate,
  ORDER_STATUSES,
  PAYMENT_METHOD_LABEL,
  STATUS_META,
  statusTimestamps,
  type OrderEventType,
  type OrderStatus,
  type PaymentMethod,
} from "@/lib/order-workflow";

/** Who did it, as the audit trail records it. */
export type Actor = { name: string; operatorId: number | null };

export type OrderActionResult = { ok: true } | { ok: false; reason: string };

const STALE = "This order changed on another screen. Refresh and try again.";

export async function getStoreTimezone(): Promise<string> {
  const [row] = await db
    .select({ timezone: storeSettings.timezone })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  return row?.timezone ?? "America/Chicago";
}

// ---------------------------------------------------------------------------
// Logged writes
// ---------------------------------------------------------------------------

/**
 * One statement that locks the order when `where` holds, applies `set`, and
 * appends the matching event, so a change and its audit row land together or
 * not at all. Returns the logged rows: none means the guard did not match
 * (another screen got there first). Drizzle's insert-select builder cannot
 * express a data-modifying CTE, hence the SQL template.
 */
function loggedUpdate(args: {
  orderId: string;
  where: SQL;
  set: SQL;
  type: OrderEventType;
  toStatus?: OrderStatus;
  note?: string | null;
  actor: Actor;
  now: Date;
}) {
  const now = args.now.toISOString();
  return db.execute<{ order_id: string; from_status: OrderStatus }>(sql`
    with prev as (
      select ${orders.id} as id, ${orders.status} as status
      from ${orders}
      where ${orders.id} = ${args.orderId} and ${args.where}
      for update
    ), moved as (
      update ${orders} set ${args.set}, updated_at = ${now}::timestamptz
      from prev where ${orders.id} = prev.id
      returning prev.id, prev.status
    )
    insert into ${orderEvents}
      (order_id, type, from_status, to_status, actor, operator_id, note, created_at)
    select id, ${args.type}::order_event_type,
      ${args.toStatus ? sql`status` : sql`null::order_status`},
      ${args.toStatus ?? null}::order_status,
      ${args.actor.name}, ${args.actor.operatorId}::integer, ${args.note ?? null},
      ${now}::timestamptz
    from moved
    returning order_id, from_status
  `);
}

const COLUMN = {
  readyAt: "ready_at",
  completedAt: "completed_at",
  canceledAt: "canceled_at",
} as const;

/**
 * A logged status move from any of `from` into `to`, stamping the columns
 * `statusTimestamps` names. `when` adds a condition (the KDS uses it to move
 * only when the items say so). Usable inside a `db.batch`.
 */
export function transitionStatement(args: {
  orderId: string;
  from: readonly OrderStatus[];
  to: OrderStatus;
  actor: Actor;
  now: Date;
  note?: string | null;
  cancelReason?: string | null;
  when?: SQL;
}) {
  const assignments = [sql`status = ${args.to}::order_status`];
  for (const [key, value] of Object.entries(statusTimestamps(args.to, args.now))) {
    const column = sql.raw(COLUMN[key as keyof typeof COLUMN]);
    assignments.push(sql`${column} = ${value?.toISOString() ?? null}::timestamptz`);
  }
  if (args.cancelReason) assignments.push(sql`cancel_reason = ${args.cancelReason}`);
  return loggedUpdate({
    orderId: args.orderId,
    where: and(inArray(orders.status, [...args.from]), args.when)!,
    set: sql.join(assignments, sql`, `),
    type: "status_changed",
    toStatus: args.to,
    note: args.note ?? args.cancelReason ?? null,
    actor: args.actor,
    now: args.now,
  });
}

export async function transitionOrder(args: {
  orderId: string;
  to: OrderStatus;
  actor: Actor;
  note?: string | null;
  cancelReason?: string | null;
}): Promise<OrderActionResult> {
  const [order] = await db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, args.orderId));
  if (!order) return { ok: false, reason: "Order not found." };
  if (!canTransition(order.status, args.to)) {
    return {
      ok: false,
      reason: `Order is already ${STATUS_META[order.status].label.toLowerCase()}.`,
    };
  }
  if (args.to === "canceled" && !args.cancelReason) {
    return { ok: false, reason: "Pick a reason for canceling." };
  }
  const { rows } = await transitionStatement({
    ...args,
    from: [order.status],
    now: new Date(),
  });
  return rows.length > 0 ? { ok: true } : { ok: false, reason: STALE };
}

export async function adjustPromisedTime(args: {
  orderId: string;
  minutes: number;
  actor: Actor;
}): Promise<OrderActionResult> {
  const now = new Date();
  const sign = args.minutes >= 0 ? "+" : "−";
  const { rows } = await loggedUpdate({
    orderId: args.orderId,
    where: inArray(orders.status, [...ACTIVE_STATUSES]),
    set: sql`promised_at = coalesce(promised_at, ${now.toISOString()}::timestamptz) + make_interval(mins => ${args.minutes}::integer)`,
    type: "eta_changed",
    note: `${sign}${Math.abs(args.minutes)} min`,
    actor: args.actor,
    now,
  });
  return rows.length > 0
    ? { ok: true }
    : { ok: false, reason: "Only active orders have a promised time to change." };
}

export async function recordPayment(args: {
  orderId: string;
  method: PaymentMethod;
  actor: Actor;
}): Promise<OrderActionResult> {
  const { rows } = await loggedUpdate({
    orderId: args.orderId,
    where: eq(orders.paymentStatus, "pending"),
    set: sql`payment_status = 'paid', payment_method = ${args.method}::payment_method`,
    type: "payment_recorded",
    note: PAYMENT_METHOD_LABEL[args.method],
    actor: args.actor,
    now: new Date(),
  });
  return rows.length > 0
    ? { ok: true }
    : { ok: false, reason: "Payment is already recorded for this order." };
}

export async function addOrderNote(args: {
  orderId: string;
  note: string;
  actor: Actor;
}): Promise<OrderActionResult> {
  const [order] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, args.orderId));
  if (!order) return { ok: false, reason: "Order not found." };
  await db.insert(orderEvents).values({
    orderId: order.id,
    type: "note_added",
    actor: args.actor.name,
    operatorId: args.actor.operatorId,
    note: args.note,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const PAGE_SIZE = 25;
export const EXPORT_CAP = 5000;

/** A real calendar day as YYYY-MM-DD; "2026-02-30" is rejected, not rolled over. */
const dateParam = z
  .string()
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  })
  .nullable()
  .catch(null);

const filtersSchema = z.object({
  q: z.string().trim().max(100).catch(""),
  status: z.enum(ORDER_STATUSES).nullable().catch(null),
  type: z.enum(["pickup", "delivery"]).nullable().catch(null),
  from: dateParam,
  to: dateParam,
  page: z.coerce.number().int().min(1).catch(1),
});

export type OrderFilters = z.infer<typeof filtersSchema>;

/** History filters from a URL: unknown or malformed values fall back to "any". */
export function parseOrderFilters(
  params: URLSearchParams | Record<string, string | string[] | undefined>,
): OrderFilters {
  const get = (key: string) => {
    const v = params instanceof URLSearchParams ? params.get(key) : params[key];
    const s = Array.isArray(v) ? v[0] : v;
    return s === undefined || s === null || s === "" ? null : s;
  };
  return filtersSchema.parse({
    q: get("q") ?? "",
    status: get("status"),
    type: get("type"),
    from: get("from"),
    to: get("to"),
    page: get("page") ?? 1,
  });
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function filterWhere(f: OrderFilters, timezone: string): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    const digits = f.q.replace(/\D/g, "");
    const number = /^#?\d+$/.test(f.q) ? Number(digits) : null;
    conditions.push(
      or(
        ilike(orders.customerName, like),
        ilike(orders.customerEmail, like),
        digits.length >= 3
          ? sql`regexp_replace(${orders.customerPhone}, '\\D', '', 'g') like ${`%${digits}%`}`
          : undefined,
        number !== null && number <= 2_147_483_647 ? eq(orders.orderNumber, number) : undefined,
      ),
    );
  }
  if (f.status) conditions.push(eq(orders.status, f.status));
  if (f.type) conditions.push(eq(orders.orderType, f.type));
  const localDay = sql`(${orders.placedAt} at time zone ${timezone})::date`;
  if (f.from) conditions.push(gte(localDay, sql`${f.from}::date`));
  if (f.to) conditions.push(lte(localDay, sql`${f.to}::date`));
  return and(...conditions);
}

export async function searchOrders(f: OrderFilters) {
  const timezone = await getStoreTimezone();
  const where = filterWhere(f, timezone);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(orders)
      .where(where)
      .orderBy(desc(orders.placedAt))
      .limit(PAGE_SIZE)
      .offset((f.page - 1) * PAGE_SIZE),
    db.select({ total: count() }).from(orders).where(where),
  ]);
  return {
    rows,
    total,
    page: f.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    timezone,
  };
}

export async function exportOrders(f: OrderFilters) {
  const timezone = await getStoreTimezone();
  const rows = await db
    .select()
    .from(orders)
    .where(filterWhere(f, timezone))
    .orderBy(desc(orders.placedAt))
    .limit(EXPORT_CAP);
  return { rows, timezone };
}

export async function getOrderDetail(id: string) {
  return db.query.orders.findFirst({
    where: eq(orders.id, id),
    with: {
      items: { orderBy: (items, { asc }) => [asc(items.id)] },
      events: { orderBy: [asc(orderEvents.createdAt), asc(orderEvents.id)] },
    },
  });
}

export type DashboardStats = {
  orders: number;
  netSalesCents: number;
  avgTicketCents: number | null;
  canceled: number;
  avgReadyMinutes: number | null;
  active: number;
  late: number;
};

/**
 * The store-local day so far. Net sales are item subtotals of orders that
 * weren't canceled: tax, tips and delivery fees are not sales.
 */
export async function getDashboardStats(now: Date): Promise<DashboardStats> {
  const timezone = await getStoreTimezone();
  const today = sql`(${orders.placedAt} at time zone ${timezone})::date = (${now.toISOString()}::timestamptz at time zone ${timezone})::date`;
  const kept = sql`${today} and ${orders.status} <> 'canceled'`;
  const [[day], active] = await Promise.all([
    db
      .select({
        orders: sql<number>`count(*) filter (where ${today})`.mapWith(Number),
        kept: sql<number>`count(*) filter (where ${kept})`.mapWith(Number),
        netSalesCents: sql<number>`coalesce(sum(${orders.subtotalCents}) filter (where ${kept}), 0)`.mapWith(Number),
        canceled: sql<number>`count(*) filter (where ${today} and ${orders.status} = 'canceled')`.mapWith(Number),
        readySeconds: sql<string | null>`avg(extract(epoch from ${orders.readyAt} - ${orders.placedAt})) filter (where ${today} and ${orders.readyAt} is not null)`,
      })
      .from(orders),
    db
      .select({ status: orders.status, promisedAt: orders.promisedAt })
      .from(orders)
      .where(inArray(orders.status, [...ACTIVE_STATUSES])),
  ]);
  return {
    orders: day.orders,
    netSalesCents: day.netSalesCents,
    avgTicketCents: day.kept > 0 ? Math.round(day.netSalesCents / day.kept) : null,
    canceled: day.canceled,
    avgReadyMinutes:
      day.readySeconds === null ? null : Math.round(Number(day.readySeconds) / 60),
    active: active.length,
    late: active.filter((o) => isLate(o.promisedAt, o.status, now)).length,
  };
}
