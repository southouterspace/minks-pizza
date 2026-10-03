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
import { getTableColumns } from "drizzle-orm";
import { db, orderDiscounts, orderEvents, orderItems, orders, storeSettings } from "@/db";
import { ACTIVE_STATUSES, isLate, ORDER_STATUSES } from "@/lib/order-workflow";

export type OrderWithItems = typeof orders.$inferSelect & {
  items: (typeof orderItems.$inferSelect)[];
};

export async function getStoreTimezone(): Promise<string> {
  const [row] = await db
    .select({ timezone: storeSettings.timezone })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  return row?.timezone ?? "America/Chicago";
}

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

const FILTER_KEYS = ["q", "status", "type", "from", "to"] as const;

/** The filters (and page) as a query string, so links and the CSV export share the URL state. */
export function filterQuery(f: OrderFilters, page?: number): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = f[key];
    if (value) params.set(key, value);
  }
  if (page && page > 1) params.set("page", String(page));
  const s = params.toString();
  return s ? `?${s}` : "";
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
    .select({
      ...getTableColumns(orders),
      discountLabels: sql<string | null>`(select string_agg(${orderDiscounts.label}, '; ' order by ${orderDiscounts.id}) from ${orderDiscounts} where ${orderDiscounts.orderId} = ${orders.id})`,
    })
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
      discounts: { orderBy: [asc(orderDiscounts.id)] },
    },
  });
}

export type OrderDetail = NonNullable<Awaited<ReturnType<typeof getOrderDetail>>>;

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
 * The store-local day so far. Net sales are item subtotals less item
 * discounts, over orders that weren't canceled: tax, tips and delivery fees
 * are not sales, so a free-delivery discount doesn't reduce them either.
 */
async function getDashboardStats(now: Date, timezone: string): Promise<DashboardStats> {
  const today = sql`(${orders.placedAt} at time zone ${timezone})::date = (${now.toISOString()}::timestamptz at time zone ${timezone})::date`;
  const kept = sql`${today} and ${orders.status} <> 'canceled'`;
  const netSales = sql`${orders.subtotalCents} - coalesce((select sum(d.amount_cents) from ${orderDiscounts} d where d.order_id = ${orders.id} and d.target = 'items'), 0)`;
  const [[day], active] = await Promise.all([
    db
      .select({
        orders: sql<number>`count(*) filter (where ${today})`.mapWith(Number),
        kept: sql<number>`count(*) filter (where ${kept})`.mapWith(Number),
        netSalesCents: sql<number>`coalesce(sum(${netSales}) filter (where ${kept}), 0)`.mapWith(Number),
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

/** Everything the orders board renders, read in parallel. */
export async function getBoard(now: Date) {
  const timezone = await getStoreTimezone();
  const [active, stats] = await Promise.all([
    db.query.orders.findMany({
      where: inArray(orders.status, [...ACTIVE_STATUSES]),
      with: { items: true },
      orderBy: [asc(orders.placedAt)],
    }),
    getDashboardStats(now, timezone),
  ]);
  return { active, stats, timezone };
}
