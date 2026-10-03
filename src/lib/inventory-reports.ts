import "server-only";
import { asc, desc, eq, sql } from "drizzle-orm";
import {
  categories,
  db,
  ingredients,
  inventoryCounts,
  inventoryMoves,
  itemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
  orderItems,
  orders,
  recipeLines,
  storeSettings,
} from "@/db";
import type { CsvCell } from "@/lib/csv";
import type { CountKind } from "@/lib/inventory-domain";
import { getStoreTimezone } from "@/lib/order-queries";
import {
  buildRecipeBook,
  ownerKey,
  plateCost,
  recipeLineFromRow,
  type RecipeContext,
} from "@/lib/recipes";
import { isPlaceable, type GroupRole, type LineModifier } from "@/lib/pricing";
import { DEFAULT_PORTIONS } from "@/lib/recipes";
import type { BaseUnit } from "@/lib/units";

export type ReportParams = URLSearchParams | Record<string, string | string[] | undefined>;

function param(params: ReportParams, key: string): string | null {
  const v = params instanceof URLSearchParams ? params.get(key) : params[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s ? s : null;
}

export function ratioBps(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part * 10_000) / whole);
}

export function formatBps(bps: number | null): string {
  return bps === null ? "—" : `${(bps / 100).toFixed(1)}%`;
}

const bpsCell = (bps: number | null): CsvCell => (bps === null ? null : (bps / 100).toFixed(2));
const dollarsCell = (cents: number | null): CsvCell => (cents === null ? null : (cents / 100).toFixed(2));
const qtyCell = (milli: number): CsvCell => Number((milli / 1000).toFixed(3));

export type DateRange = { from: string; to: string };

const DEFAULT_RANGE_DAYS = 7;
const MAX_RANGE_DAYS = 366;

function isCalendarDay(s: string | null): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function storeToday(timezone: string, now = new Date()): string {
  return now.toLocaleDateString("sv-SE", { timeZone: timezone });
}

export function resolveRange(params: ReportParams, today: string): DateRange {
  const rawFrom = param(params, "from");
  const rawTo = param(params, "to");
  let to = isCalendarDay(rawTo) ? rawTo : today;
  let from = isCalendarDay(rawFrom) ? rawFrom : addDays(to, 1 - DEFAULT_RANGE_DAYS);
  if (from > to) [from, to] = [to, from];
  if (from < addDays(to, 1 - MAX_RANGE_DAYS)) from = addDays(to, 1 - MAX_RANGE_DAYS);
  return { from, to };
}

export function rangeQuery(range: DateRange): string {
  return `?${new URLSearchParams(range).toString()}`;
}

function soldIn(range: DateRange, timezone: string) {
  return sql`${orders.status} = 'completed'
    and ${orders.placedAt} >= (${range.from}::date::timestamp at time zone ${timezone})
    and ${orders.placedAt} < ((${range.to}::date + 1)::timestamp at time zone ${timezone})`;
}

export type FoodCostTotals = {
  orders: number;
  netSalesCents: number;
  lineSalesCents: number;
  costedSalesCents: number;
  cogsCents: number;
};

export type FoodCostRow = FoodCostTotals & { day: string };

export const foodCostBps = (r: FoodCostTotals) => ratioBps(r.cogsCents, r.costedSalesCents);
export const coverageBps = (r: FoodCostTotals) => ratioBps(r.costedSalesCents, r.lineSalesCents);

export type FoodCostReport = {
  range: DateRange;
  timezone: string;
  days: FoodCostRow[];
  total: FoodCostTotals;
};

export async function foodCostReport(params: ReportParams): Promise<FoodCostReport> {
  const timezone = await getStoreTimezone();
  const range = resolveRange(params, storeToday(timezone));
  const localDay = sql`(${orders.placedAt} at time zone ${timezone})::date`;
  const { rows } = await db.execute<{
    day: string;
    orders: string;
    net_sales: string;
    line_sales: string;
    costed_sales: string;
    cogs: string;
  }>(sql`
    with sold as (
      select ${orders.id} as id, ${localDay} as day, ${orders.subtotalCents} as subtotal
      from ${orders} where ${soldIn(range, timezone)}
    ), by_order as (
      select day, count(*) as orders, sum(subtotal) as net_sales from sold group by day
    ), by_line as (
      select s.day,
        sum(${orderItems.lineTotalCents}) as line_sales,
        sum(${orderItems.lineTotalCents}) filter (where ${orderItems.costCents} is not null) as costed_sales,
        sum(${orderItems.costCents}) as cogs
      from sold s join ${orderItems} on ${orderItems.orderId} = s.id
      group by s.day
    )
    select to_char(d, 'YYYY-MM-DD') as day,
      coalesce(o.orders, 0)::text as orders,
      coalesce(o.net_sales, 0)::text as net_sales,
      coalesce(l.line_sales, 0)::text as line_sales,
      coalesce(l.costed_sales, 0)::text as costed_sales,
      coalesce(l.cogs, 0)::text as cogs
    from generate_series(${range.from}::date, ${range.to}::date, interval '1 day') as d
    left join by_order o on o.day = d::date
    left join by_line l on l.day = d::date
    order by d
  `);
  const days: FoodCostRow[] = rows.map((r) => ({
    day: r.day,
    orders: Number(r.orders),
    netSalesCents: Number(r.net_sales),
    lineSalesCents: Number(r.line_sales),
    costedSalesCents: Number(r.costed_sales),
    cogsCents: Number(r.cogs),
  }));
  const total = days.reduce<FoodCostTotals>(
    (t, d) => ({
      orders: t.orders + d.orders,
      netSalesCents: t.netSalesCents + d.netSalesCents,
      lineSalesCents: t.lineSalesCents + d.lineSalesCents,
      costedSalesCents: t.costedSalesCents + d.costedSalesCents,
      cogsCents: t.cogsCents + d.cogsCents,
    }),
    { orders: 0, netSalesCents: 0, lineSalesCents: 0, costedSalesCents: 0, cogsCents: 0 },
  );
  return { range, timezone, days, total };
}

export type CountSummary = { id: number; kind: CountKind; createdAt: Date; ingredients: number };

export type VarianceRow = {
  ingredientId: number;
  name: string;
  baseUnit: BaseUnit;
  since: Date | null;
  openingMilli: number;
  receivedMilli: number;
  wastedMilli: number;
  usageMilli: number;
  expectedMilli: number;
  countedMilli: number;
  varianceMilli: number;
  usageCents: number;
  varianceCents: number;
};

export type VarianceReport = {
  counts: CountSummary[];
  count: CountSummary | null;
  rows: VarianceRow[];
  usageCents: number;
  varianceCents: number;
};

const COUNT_CHOICES = 100;

function countSummaries() {
  return db
    .select({
      id: inventoryCounts.id,
      kind: inventoryCounts.kind,
      createdAt: inventoryCounts.createdAt,
      ingredients: sql<number>`count(distinct ${inventoryMoves.ingredientId})`.mapWith(Number),
    })
    .from(inventoryCounts)
    .leftJoin(inventoryMoves, eq(inventoryMoves.countId, inventoryCounts.id))
    .groupBy(inventoryCounts.id)
    .$dynamic();
}

export async function varianceReport(params: ReportParams): Promise<VarianceReport> {
  const counts: CountSummary[] = await countSummaries()
    .orderBy(desc(inventoryCounts.id))
    .limit(COUNT_CHOICES);
  const asked = Number(param(params, "count"));
  let count = counts.find((c) => c.id === asked) ?? null;
  if (!count && Number.isSafeInteger(asked) && asked > 0) {
    [count = null] = await countSummaries().where(eq(inventoryCounts.id, asked));
    if (count) counts.push(count);
  }
  count ??= counts[0] ?? null;
  if (!count) return { counts, count, rows: [], usageCents: 0, varianceCents: 0 };

  const { rows } = await db.execute<{
    ingredient_id: number;
    name: string;
    base_unit: BaseUnit;
    since: string | null;
    opening: string;
    received: string;
    wasted: string;
    usage: string;
    usage_cents: string;
    expected: string;
    variance: string;
    variance_cents: string;
  }>(sql`
    with counted as (
      select ingredient_id, min(id) as move_id, sum(qty_milli) as variance,
        round(sum(qty_milli::numeric * unit_cost_millicents) / 1000000) as variance_cents
      from ${inventoryMoves}
      where count_id = ${count.id} and kind = 'count'
      group by ingredient_id
    ), previous as (
      select c.*, (
        select max(p.id) from ${inventoryMoves} p
        where p.ingredient_id = c.ingredient_id and p.kind = 'count' and p.id < c.move_id
      ) as prev_id
      from counted c
    )
    select c.ingredient_id, i.name, i.base_unit,
      (select (extract(epoch from created_at) * 1000)::bigint from ${inventoryMoves} where id = c.prev_id)::text as since,
      coalesce(sum(m.qty_milli) filter (where m.id <= c.prev_id), 0)::text as opening,
      coalesce(sum(m.qty_milli) filter (where m.id > coalesce(c.prev_id, 0) and m.kind = 'receive'), 0)::text as received,
      (-coalesce(sum(m.qty_milli) filter (where m.id > coalesce(c.prev_id, 0) and m.kind = 'waste'), 0))::text as wasted,
      (-coalesce(sum(m.qty_milli) filter (where m.id > coalesce(c.prev_id, 0) and m.kind = 'sale'), 0))::text as usage,
      (-coalesce(round(sum(m.qty_milli::numeric * m.unit_cost_millicents)
        filter (where m.id > coalesce(c.prev_id, 0) and m.kind = 'sale') / 1000000), 0))::text as usage_cents,
      coalesce(sum(m.qty_milli), 0)::text as expected,
      c.variance::text as variance,
      c.variance_cents::text as variance_cents
    from previous c
    join ${ingredients} i on i.id = c.ingredient_id
    left join ${inventoryMoves} m on m.ingredient_id = c.ingredient_id and m.id < c.move_id
    group by c.ingredient_id, c.prev_id, c.variance, c.variance_cents, i.name, i.base_unit
  `);
  const out: VarianceRow[] = rows.map((r) => {
    const expectedMilli = Number(r.expected);
    const varianceMilli = Number(r.variance);
    return {
      ingredientId: r.ingredient_id,
      name: r.name,
      baseUnit: r.base_unit,
      since: r.since === null ? null : new Date(Number(r.since)),
      openingMilli: Number(r.opening),
      receivedMilli: Number(r.received),
      wastedMilli: Number(r.wasted),
      usageMilli: Number(r.usage),
      expectedMilli,
      countedMilli: expectedMilli + varianceMilli,
      varianceMilli,
      usageCents: Number(r.usage_cents),
      varianceCents: Number(r.variance_cents),
    };
  });
  out.sort((a, b) => b.usageCents - a.usageCents || a.name.localeCompare(b.name));
  return {
    counts,
    count,
    rows: out,
    usageCents: out.reduce((s, r) => s + r.usageCents, 0),
    varianceCents: out.reduce((s, r) => s + r.varianceCents, 0),
  };
}

export type ToppingMixRow = {
  sizeId: number;
  size: string;
  toppingId: number;
  topping: string;
  pizzas: number;
  withTopping: number;
  half: number;
  light: number;
  extra: number;
};

export const attachBps = (r: ToppingMixRow) => ratioBps(r.withTopping, r.pizzas);
export const halfShareBps = (r: ToppingMixRow) => ratioBps(r.half, r.withTopping);
export const lightShareBps = (r: ToppingMixRow) => ratioBps(r.light, r.withTopping);
export const extraShareBps = (r: ToppingMixRow) => ratioBps(r.extra, r.withTopping);

export type ToppingMixReport = {
  range: DateRange;
  sizes: { sizeId: number; size: string; pizzas: number; rows: ToppingMixRow[] }[];
};

type ModifierInfo = { name: string; role: GroupRole; order: number };

function tallyToppingMix(
  lines: readonly { quantity: number; modifiers: readonly LineModifier[] }[],
  info: ReadonlyMap<number, ModifierInfo>,
): ToppingMixReport["sizes"] {
  const sizes = new Map<number, { pizzas: number; toppings: Map<number, ToppingMixRow> }>();
  for (const line of lines) {
    const roleOf = (m: LineModifier) => (m.modifierId === null ? undefined : info.get(m.modifierId)?.role);
    const sizeId = line.modifiers.find((m) => roleOf(m) === "size")?.modifierId;
    if (sizeId === undefined || sizeId === null) continue;
    const size = sizes.get(sizeId) ?? { pizzas: 0, toppings: new Map() };
    sizes.set(sizeId, size);
    size.pizzas += line.quantity;
    for (const m of line.modifiers) {
      const role = roleOf(m);
      if (m.kind !== "placed" || !role || !isPlaceable(role) || m.modifierId === null) continue;
      const row = size.toppings.get(m.modifierId) ?? {
        sizeId,
        size: info.get(sizeId)!.name,
        toppingId: m.modifierId,
        topping: info.get(m.modifierId)!.name,
        pizzas: 0,
        withTopping: 0,
        half: 0,
        light: 0,
        extra: 0,
      };
      size.toppings.set(m.modifierId, row);
      row.withTopping += line.quantity;
      if (m.placement !== "whole") row.half += line.quantity;
      if (m.amount === "light") row.light += line.quantity;
      if (m.amount === "extra") row.extra += line.quantity;
    }
  }
  return [...sizes]
    .map(([sizeId, { pizzas, toppings }]) => ({
      sizeId,
      size: info.get(sizeId)!.name,
      pizzas,
      rows: [...toppings.values()]
        .map((r) => ({ ...r, pizzas }))
        .sort((a, b) => b.withTopping - a.withTopping || a.topping.localeCompare(b.topping)),
    }))
    .sort((a, b) => info.get(a.sizeId)!.order - info.get(b.sizeId)!.order);
}

export async function toppingMixReport(params: ReportParams): Promise<ToppingMixReport> {
  const timezone = await getStoreTimezone();
  const range = resolveRange(params, storeToday(timezone));
  const [lines, mods] = await Promise.all([
    db
      .select({ quantity: orderItems.quantity, modifiers: orderItems.modifiers })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(soldIn(range, timezone)),
    db
      .select({
        id: modifiers.id,
        name: modifiers.name,
        role: modifierGroups.role,
        groupOrder: modifierGroups.sortOrder,
        order: modifiers.sortOrder,
      })
      .from(modifiers)
      .innerJoin(modifierGroups, eq(modifierGroups.id, modifiers.groupId))
      .orderBy(asc(modifierGroups.sortOrder), asc(modifierGroups.id), asc(modifiers.sortOrder), asc(modifiers.id)),
  ]);
  const info = new Map(mods.map((m, i) => [m.id, { name: m.name, role: m.role, order: i }]));
  return { range, sizes: tallyToppingMix(lines, info) };
}

export type MarginRow = {
  itemId: number;
  item: string;
  category: string;
  sizeId: number | null;
  size: string | null;
  priceCents: number;
  plateCostCents: number | null;
  marginCents: number | null;
  marginBps: number | null;
  low: boolean;
};

export type MarginReport = { minMarginBps: number; rows: MarginRow[] };

export async function marginReport(): Promise<MarginReport> {
  const [items, links, mods, recipeRows, costRows, [settings]] = await Promise.all([
    db
      .select({ id: menuItems.id, name: menuItems.name, basePriceCents: menuItems.basePriceCents, category: categories.name })
      .from(menuItems)
      .innerJoin(categories, eq(categories.id, menuItems.categoryId))
      .orderBy(asc(categories.sortOrder), asc(categories.id), asc(menuItems.sortOrder), asc(menuItems.id)),
    db
      .select({ itemId: itemModifierGroups.itemId, groupId: itemModifierGroups.groupId, role: modifierGroups.role })
      .from(itemModifierGroups)
      .innerJoin(modifierGroups, eq(modifierGroups.id, itemModifierGroups.groupId))
      .orderBy(asc(itemModifierGroups.sortOrder), asc(itemModifierGroups.id)),
    db.select().from(modifiers).orderBy(asc(modifiers.sortOrder), asc(modifiers.id)),
    db.select().from(recipeLines),
    db.select({ id: ingredients.id, cost: ingredients.unitCostMillicents }).from(ingredients),
    db
      .select({
        halfPortionBps: storeSettings.halfPortionBps,
        lightPortionBps: storeSettings.lightPortionBps,
        extraPortionBps: storeSettings.extraPortionBps,
        minMarginBps: storeSettings.minMarginBps,
      })
      .from(storeSettings)
      .where(eq(storeSettings.id, 1)),
  ]);
  const minMarginBps = settings?.minMarginBps ?? 7000;
  const book = buildRecipeBook(recipeRows.map(recipeLineFromRow));
  const sizeGroupIds = new Set(links.filter((l) => l.role === "size").map((l) => l.groupId));
  const ctx: RecipeContext = {
    book,
    sizeModifierIds: new Set(mods.filter((m) => sizeGroupIds.has(m.groupId)).map((m) => m.id)),
    settings: settings ?? DEFAULT_PORTIONS,
  };
  const unitCosts = new Map(costRows.map((r) => [r.id, r.cost]));

  const rows = items.flatMap((item) => {
    const groups = links.filter((l) => l.itemId === item.id);
    const inGroups = (kind: "size" | "other") =>
      groups
        .filter((g) => (g.role === "size") === (kind === "size"))
        .flatMap((g) => mods.filter((m) => m.groupId === g.groupId));
    const defaults = inGroups("other").filter((m) => m.isDefault);
    const sizes = inGroups("size");
    const hasRecipe = book.has(ownerKey({ kind: "item", id: item.id }));
    const priceBase = item.basePriceCents + defaults.reduce((s, m) => s + m.priceDeltaCents, 0);
    return (sizes.length ? sizes : [null]).map((size): MarginRow => {
      const priceCents = priceBase + (size?.priceDeltaCents ?? 0);
      const plateCostCents = hasRecipe
        ? plateCost(item.id, size?.id ?? null, defaults.map((m) => m.id), ctx, unitCosts)
        : null;
      const marginCents = plateCostCents === null ? null : priceCents - plateCostCents;
      const marginBps = marginCents === null ? null : ratioBps(marginCents, priceCents);
      return {
        itemId: item.id,
        item: item.name,
        category: item.category,
        sizeId: size?.id ?? null,
        size: size?.name ?? null,
        priceCents,
        plateCostCents,
        marginCents,
        marginBps,
        low: marginBps !== null && marginBps < minMarginBps,
      };
    });
  });
  return { minMarginBps, rows };
}

export type CsvTable = { filename: string; header: string[]; rows: CsvCell[][] };

type ReportDef = { slug: string; title: string; csv: (params: ReportParams) => Promise<CsvTable> };

export const REPORTS = [
  {
    slug: "food-cost",
    title: "Food cost",
    async csv(params) {
      const { range, days, total } = await foodCostReport(params);
      return {
        filename: `food-cost-${range.from}-to-${range.to}.csv`,
        header: ["Day", "Orders", "Net sales", "COGS", "Food cost %", "Cost known for % of sales"],
        rows: [...days, { ...total, day: "Total" }].map((r) => [
          r.day,
          r.orders,
          dollarsCell(r.netSalesCents),
          dollarsCell(r.cogsCents),
          bpsCell(foodCostBps(r)),
          bpsCell(coverageBps(r)),
        ]),
      };
    },
  },
  {
    slug: "variance",
    title: "Variance",
    async csv(params) {
      const [{ count, rows }, timezone] = await Promise.all([varianceReport(params), getStoreTimezone()]);
      const local = (d: Date) => d.toLocaleString("sv-SE", { timeZone: timezone, hour12: false }).slice(0, 16);
      return {
        filename: `variance-count-${count?.id ?? "none"}.csv`,
        header: [
          "Ingredient", "Unit", "Since", "Opening", "Received", "Wasted", "Theoretical usage",
          "Expected", "Counted", "Variance", "Usage $", "Variance $",
        ],
        rows: rows.map((r) => [
          r.name,
          r.baseUnit,
          r.since ? local(r.since) : "first move",
          qtyCell(r.openingMilli),
          qtyCell(r.receivedMilli),
          qtyCell(r.wastedMilli),
          qtyCell(r.usageMilli),
          qtyCell(r.expectedMilli),
          qtyCell(r.countedMilli),
          qtyCell(r.varianceMilli),
          dollarsCell(r.usageCents),
          dollarsCell(r.varianceCents),
        ]),
      };
    },
  },
  {
    slug: "toppings",
    title: "Topping mix",
    async csv(params) {
      const { range, sizes } = await toppingMixReport(params);
      return {
        filename: `topping-mix-${range.from}-to-${range.to}.csv`,
        header: ["Size", "Topping", "Pizzas", "With topping", "Attach %", "Half %", "Light %", "Extra %"],
        rows: sizes.flatMap((s) =>
          s.rows.map((r) => [
            r.size,
            r.topping,
            r.pizzas,
            r.withTopping,
            bpsCell(attachBps(r)),
            bpsCell(halfShareBps(r)),
            bpsCell(lightShareBps(r)),
            bpsCell(extraShareBps(r)),
          ]),
        ),
      };
    },
  },
  {
    slug: "margins",
    title: "Margins",
    async csv() {
      const { rows } = await marginReport();
      return {
        filename: "margins.csv",
        header: ["Category", "Item", "Size", "Price", "Plate cost", "Margin $", "Margin %", "Below minimum"],
        rows: rows.map((r) => [
          r.category,
          r.item,
          r.size,
          dollarsCell(r.priceCents),
          dollarsCell(r.plateCostCents),
          dollarsCell(r.marginCents),
          bpsCell(r.marginBps),
          r.low ? "yes" : "",
        ]),
      };
    },
  },
] as const satisfies readonly ReportDef[];

export type ReportSlug = (typeof REPORTS)[number]["slug"];
