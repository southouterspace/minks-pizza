// Not server-only: folds.ts runs the stock reconcile from scripts too.
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  db,
  ingredientPacks,
  ingredients,
  inventoryCounts,
  inventoryMoves,
  menuItems,
  modifierGroups,
  modifiers,
  orderEvents,
  orderItems,
  orders,
  recipeLines,
  stockOuts,
  storeSettings,
} from "@/db";
import {
  milliToCents,
  type CountKind,
  type InventoryMoveKind,
  type WasteReason,
} from "@/lib/inventory-domain";
import type { BaseUnit, UnitDef } from "@/lib/units";
import {
  buildRecipeBook,
  costCents,
  orderLineUsage,
  orderUsage,
  recipeLineFromRow,
  type RecipeContext,
  type UsageLine,
} from "@/lib/recipes";
import { DEFAULT_PORTIONS } from "@/lib/recipes";
import { lineCaps, type Stock } from "@/lib/stock";
import { ACTIVE_STATUSES } from "@/lib/order-workflow";

function intRows(rows: readonly (readonly (number | null)[])[]): SQL {
  return sql`(values ${sql.join(
    rows.map((cells) => sql`(${sql.join(cells.map((c) => sql`${c}::integer`), sql`, `)})`),
    sql`, `,
  )})`;
}

function pairs(rows: readonly (readonly [number, number])[]): SQL {
  return rows.length === 0 ? sql`(select null::integer, null::integer where false)` : intRows(rows);
}

async function portionSettings() {
  const [row] = await db
    .select({
      halfPortionBps: storeSettings.halfPortionBps,
      lightPortionBps: storeSettings.lightPortionBps,
      extraPortionBps: storeSettings.extraPortionBps,
    })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  return row ?? DEFAULT_PORTIONS;
}

export type OrderUsagePlan = {
  orderId: string;
  usage: ReadonlyMap<number, number>;
  lineCosts: readonly (readonly [number, number])[];
};

/** The recipes, size modifiers and portion rules that turn these lines into ingredient usage. */
async function recipeContextFor(lines: readonly UsageLine[]): Promise<RecipeContext> {
  const itemIds = [...new Set(lines.flatMap((l) => (l.menuItemId === null ? [] : [l.menuItemId])))];
  const modifierIds = [
    ...new Set(
      lines.flatMap((l) =>
        l.modifiers.flatMap((m) => (m.modifierId === null ? [] : [m.modifierId])),
      ),
    ),
  ];
  const owners = [
    itemIds.length ? inArray(recipeLines.menuItemId, itemIds) : undefined,
    modifierIds.length ? inArray(recipeLines.modifierId, modifierIds) : undefined,
  ].filter((c) => c !== undefined);

  const [recipeRows, sizeRows, settings] = await Promise.all([
    owners.length ? db.select().from(recipeLines).where(or(...owners)) : [],
    modifierIds.length
      ? db
          .select({ id: modifiers.id })
          .from(modifiers)
          .innerJoin(modifierGroups, eq(modifierGroups.id, modifiers.groupId))
          .where(and(eq(modifierGroups.role, "size"), inArray(modifiers.id, modifierIds)))
      : [],
    portionSettings(),
  ]);

  return {
    book: buildRecipeBook(recipeRows.map(recipeLineFromRow)),
    sizeModifierIds: new Set(sizeRows.map((r) => r.id)),
    settings,
  };
}

/**
 * What each tracked ingredient can still give, down to its 86 threshold.
 * Like syncStockOuts, only an active ingredient that has been received or
 * counted is tracked; the rest are left out and never limit an order.
 */
async function loadStock(ingredientIds: readonly number[]): Promise<Stock> {
  if (ingredientIds.length === 0) return new Map();
  const { rows } = await db.execute<{ id: number; available: string }>(sql`
    select i.id, (coalesce(sum(m.qty_milli), 0) - coalesce(i.out_at_milli, 0))::text as available
    from ${ingredients} i
    join ${inventoryMoves} m on m.ingredient_id = i.id
    where i.is_active and i.id in (${sql.join(ingredientIds.map((id) => sql`${id}`), sql`, `)})
    group by i.id
    having bool_or(m.kind in ('receive', 'count'))
  `);
  return new Map(rows.map((r) => [Number(r.id), Number(r.available)]));
}

/**
 * How many of each line the shelves allow alongside the others; null where
 * nothing tracked limits it. Open orders only write their sale moves when
 * they complete, so their usage is held back here first.
 */
export async function stockCaps(lines: readonly UsageLine[]): Promise<(number | null)[]> {
  const open = await db
    .select({ menuItemId: orderItems.menuItemId, quantity: orderItems.quantity, modifiers: orderItems.modifiers })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(inArray(orders.status, ACTIVE_STATUSES), isNull(orderItems.voidedAt)));
  const ctx = await recipeContextFor([...lines, ...open]);
  const ingredientIds = [...new Set([...ctx.book.values()].flatMap((ls) => ls.map((l) => l.ingredientId)))];
  const onShelf = await loadStock(ingredientIds);
  const held = orderUsage(open, ctx);
  const stock = new Map([...onShelf].map(([id, qty]) => [id, qty - (held.get(id) ?? 0)]));
  return lineCaps(lines, ctx, stock);
}

export async function planOrderUsage(orderId: string): Promise<OrderUsagePlan> {
  const lines = await db
    .select({
      id: orderItems.id,
      menuItemId: orderItems.menuItemId,
      quantity: orderItems.quantity,
      modifiers: orderItems.modifiers,
    })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), isNull(orderItems.voidedAt)));
  const ctx = await recipeContextFor(lines);
  const usageLines: UsageLine[] = lines;
  const usage = orderUsage(usageLines, ctx);
  const costRows = usage.size
    ? await db
        .select({ id: ingredients.id, unitCostMillicents: ingredients.unitCostMillicents })
        .from(ingredients)
        .where(inArray(ingredients.id, [...usage.keys()]))
    : [];
  const unitCosts = new Map(costRows.map((r) => [r.id, r.unitCostMillicents]));
  const lineCosts = lines.map(
    (l) => [l.id, costCents(orderLineUsage(l, ctx), unitCosts)] as const,
  );
  return { orderId, usage, lineCosts };
}

/**
 * One statement that brings the order's `sale` moves in line with its
 * status: a completed order holds its full theoretical usage (the food was
 * made whatever was refunded), any other order holds nothing. It reads the status itself, so placed in a
 * `db.batch` right after a status transition it sees that transition, and
 * it only inserts the difference, so running it again changes nothing. It
 * also stamps each line's food cost while the order is completed. Built
 * from a plan rather than an order id because `db.execute` is a thenable:
 * returning it from an async function would run it on the caller's await.
 */
export function inventorySyncStatement({ orderId, usage, lineCosts }: OrderUsagePlan) {
  return db.execute<{ order_id: string; ingredient_id: number; qty_milli: number }>(sql`
    with wanted as (
      select (${orders.status} = 'completed') as active
      from ${orders} where ${orders.id} = ${orderId}
      for update
    ), target as (
      select u.ingredient_id, case when wanted.active then -u.qty_milli else 0 end as qty_milli
      from ${pairs([...usage])} as u(ingredient_id, qty_milli), wanted
    ), held as (
      select ingredient_id, sum(qty_milli) as qty_milli
      from ${inventoryMoves}
      where order_id = ${orderId} and kind = 'sale'
      group by ingredient_id
    ), delta as (
      select ingredient_id, coalesce(t.qty_milli, 0) - coalesce(h.qty_milli, 0) as qty_milli
      from target t full join held h using (ingredient_id)
      where coalesce(t.qty_milli, 0) - coalesce(h.qty_milli, 0) <> 0
    ), moved as (
      insert into ${inventoryMoves} (ingredient_id, kind, qty_milli, unit_cost_millicents, order_id)
      select d.ingredient_id, 'sale', d.qty_milli, i.unit_cost_millicents, ${orderId}
      from delta d join ${ingredients} i on i.id = d.ingredient_id
      returning ingredient_id, qty_milli
    ), costed as (
      update ${orderItems} set cost_cents = case when wanted.active then c.cost_cents else null end
      from ${pairs(lineCosts)} as c(id, cost_cents), wanted
      where ${orderItems.id} = c.id
    )
    select ${orderId}::uuid as order_id, ingredient_id, qty_milli from moved
  `);
}

export type StockOutTrigger = { orderId: string };

type StockRow = {
  id: number;
  name: string;
  out_at_milli: number | null;
  is_active: boolean;
  on_hand: string;
  tracked: boolean;
  has_row: boolean;
};

/**
 * Brings `stock_outs` in line with on-hand quantities. Only an ingredient
 * that has been received or counted is judged: before that its on hand is
 * just minus its sales, and a threshold would 86 the menu on day one. One that
 * just crossed its threshold 86's every available item and modifier whose
 * recipe uses it and remembers which; one that came back turns exactly those
 * back on unless another stock-out still lists them. An operator who turns
 * an item back on by hand leaves the row in place, so later sales don't 86
 * it again. Returns the ingredient ids that went out and that were restored.
 */
export async function syncStockOuts(
  trigger?: StockOutTrigger,
): Promise<{ wentOut: number[]; restored: number[] }> {
  const { rows } = await db.execute<StockRow>(sql`
    select i.id, i.name, i.out_at_milli, i.is_active,
      coalesce(sum(m.qty_milli), 0)::text as on_hand,
      coalesce(bool_or(m.kind in ('receive', 'count')), false) as tracked,
      (s.ingredient_id is not null) as has_row
    from ${ingredients} i
    left join ${inventoryMoves} m on m.ingredient_id = i.id
    left join ${stockOuts} s on s.ingredient_id = i.id
    where i.out_at_milli is not null or s.ingredient_id is not null
    group by i.id, s.ingredient_id
    order by i.id
  `);

  const wentOut: number[] = [];
  const restored: number[] = [];
  for (const row of rows) {
    const out =
      row.is_active &&
      row.tracked &&
      row.out_at_milli !== null &&
      Number(row.on_hand) <= row.out_at_milli;
    if (out && !row.has_row) {
      const { rows: added } = await markOut(row, trigger);
      if (added.length) wentOut.push(row.id);
    } else if (!out && row.has_row) {
      await restore(row.id);
      restored.push(row.id);
    }
  }
  return { wentOut, restored };
}

function markOut(row: StockRow, trigger?: StockOutTrigger) {
  const noted = trigger
    ? sql`, noted as (
      insert into ${orderEvents} (order_id, type, actor, note)
      select ${trigger.orderId}, 'note_added', 'Inventory',
        ${row.name} || ' ran out' || coalesce(' · 86''d ' || nullif((
          select string_agg(name, ', ' order by kind, name)
          from (select 0 as kind, name from hit_items union all select 1, name from hit_mods) n
        ), ''), '')
      from added
    )`
    : sql``;
  return db.execute<{ menu_item_ids: number[]; modifier_ids: number[] }>(sql`
    with hit_items as (
      select distinct m.id, m.name
      from ${recipeLines} r join ${menuItems} m on m.id = r.menu_item_id
      where r.ingredient_id = ${row.id} and r.qty_milli > 0 and m.is_available
    ), hit_mods as (
      select distinct m.id, m.name
      from ${recipeLines} r join ${modifiers} m on m.id = r.modifier_id
      where r.ingredient_id = ${row.id} and r.qty_milli > 0 and m.is_available
    ), added as (
      insert into ${stockOuts} (ingredient_id, menu_item_ids, modifier_ids)
      values (
        ${row.id},
        coalesce((select array_agg(id order by id) from hit_items), '{}'),
        coalesce((select array_agg(id order by id) from hit_mods), '{}')
      )
      on conflict (ingredient_id) do nothing
      returning menu_item_ids, modifier_ids
    ), off_items as (
      update ${menuItems} set is_available = false, updated_at = now()
      where id in (select unnest(menu_item_ids) from added)
    ), off_mods as (
      update ${modifiers} set is_available = false
      where id in (select unnest(modifier_ids) from added)
    )${noted}
    select menu_item_ids, modifier_ids from added
  `);
}

function restore(ingredientId: number) {
  return db.execute(sql`
    with gone as (
      delete from ${stockOuts} where ingredient_id = ${ingredientId}
      returning menu_item_ids, modifier_ids
    ), still as (
      select menu_item_ids, modifier_ids from ${stockOuts} where ingredient_id <> ${ingredientId}
    ), on_items as (
      update ${menuItems} set is_available = true, updated_at = now()
      where id in (select unnest(menu_item_ids) from gone)
        and id not in (select unnest(menu_item_ids) from still)
    ), on_mods as (
      update ${modifiers} set is_available = true
      where id in (select unnest(modifier_ids) from gone)
        and id not in (select unnest(modifier_ids) from still)
    )
    select 1 from gone
  `);
}

export async function onHand(ingredientIds?: readonly number[]): Promise<Map<number, number>> {
  const rows = await db
    .select({
      id: ingredients.id,
      onHand: sql<string>`coalesce(sum(${inventoryMoves.qtyMilli}), 0)`,
    })
    .from(ingredients)
    .leftJoin(inventoryMoves, eq(inventoryMoves.ingredientId, ingredients.id))
    .where(ingredientIds ? inArray(ingredients.id, [...ingredientIds]) : undefined)
    .groupBy(ingredients.id);
  return new Map(rows.map((r) => [r.id, Number(r.onHand)]));
}

export type NewMove = {
  ingredientId: number;
  kind: InventoryMoveKind;
  qtyMilli: number;
  unitCostMillicents?: number;
  countId?: number | null;
  wasteReason?: WasteReason | null;
  vendor?: string | null;
  operatorId?: number | null;
};

export async function recordMoves(moves: readonly NewMove[]): Promise<void> {
  if (moves.length === 0) return;
  await db.insert(inventoryMoves).values(
    moves.map((m) => ({
      ...m,
      unitCostMillicents:
        m.unitCostMillicents ??
        sql`(select unit_cost_millicents from ${ingredients} where ${ingredients.id} = ${m.ingredientId})`,
    })),
  );
  await syncStockOuts();
}

export type StockStatus = "out" | "low" | "uncounted" | "ok";

export type StockLine = {
  id: number;
  name: string;
  baseUnit: BaseUnit;
  storageArea: string;
  unitCostMillicents: number;
  lowStockAtMilli: number | null;
  onHandMilli: number;
  status: StockStatus;
  packs: UnitDef[];
};

function stockStatus(r: {
  stocked_out: boolean;
  tracked: boolean;
  low_stock_at_milli: number | null;
  on_hand: number;
}): StockStatus {
  if (r.stocked_out) return "out";
  if (!r.tracked) return "uncounted";
  if (r.low_stock_at_milli !== null && r.on_hand <= r.low_stock_at_milli) return "low";
  return "ok";
}

export async function stockLines(): Promise<StockLine[]> {
  const [{ rows }, packs] = await Promise.all([
    db.execute<{
      id: number;
      name: string;
      base_unit: BaseUnit;
      storage_area: string;
      unit_cost_millicents: number;
      low_stock_at_milli: number | null;
      on_hand: number;
      tracked: boolean;
      stocked_out: boolean;
    }>(sql`
      select i.id, i.name, i.base_unit, i.storage_area, i.unit_cost_millicents, i.low_stock_at_milli,
        coalesce(sum(m.qty_milli), 0)::float8 as on_hand,
        coalesce(bool_or(m.kind in ('receive', 'count')), false) as tracked,
        exists (select 1 from ${stockOuts} s where s.ingredient_id = i.id) as stocked_out
      from ${ingredients} i
      left join ${inventoryMoves} m on m.ingredient_id = i.id
      where i.is_active
      group by i.id
      order by i.storage_area, i.shelf_order, i.name
    `),
    db
      .select({ ingredientId: ingredientPacks.ingredientId, name: ingredientPacks.name, baseQtyMilli: ingredientPacks.baseQtyMilli })
      .from(ingredientPacks)
      .orderBy(ingredientPacks.baseQtyMilli),
  ]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    baseUnit: r.base_unit,
    storageArea: r.storage_area,
    unitCostMillicents: r.unit_cost_millicents,
    lowStockAtMilli: r.low_stock_at_milli,
    onHandMilli: r.on_hand,
    status: stockStatus(r),
    packs: packs
      .filter((p) => p.ingredientId === r.id)
      .map((p) => ({ name: p.name, baseQtyMilli: p.baseQtyMilli })),
  }));
}

export type SpotRule = "usage" | "value";

export async function spotCountPreset(): Promise<{ ids: number[]; rule: SpotRule }> {
  const { rows } = await db.execute<{ id: number; usage: string }>(sql`
    select i.id,
      coalesce((
        select -sum(m.qty_milli::numeric * m.unit_cost_millicents)
        from ${inventoryMoves} m
        where m.ingredient_id = i.id and m.kind = 'sale' and m.created_at > now() - interval '7 days'
      ), 0) as usage,
      coalesce((select sum(m.qty_milli) from ${inventoryMoves} m where m.ingredient_id = i.id), 0)::numeric
        * i.unit_cost_millicents as value
    from ${ingredients} i
    where i.is_active
    order by usage desc, value desc, i.id
    limit 5
  `);
  return {
    ids: rows.map((r) => r.id),
    rule: rows.some((r) => Number(r.usage) > 0) ? "usage" : "value",
  };
}

/**
 * Posts a count: one `count` move per line, each the counted quantity minus
 * on hand as of this very statement, so a sale landing mid-submit can't skew
 * the variance. A line equal to on hand still posts (a zero move): it is
 * what marks the ingredient as counted.
 */
export async function recordCount(input: {
  kind: CountKind;
  operatorId: number | null;
  lines: readonly { ingredientId: number; countedMilli: number }[];
}): Promise<{ countId: number; moves: { ingredientId: number; qtyMilli: number }[] }> {
  const { rows } = await db.execute<{ count_id: number; ingredient_id: number; qty_milli: number }>(sql`
    with c as (
      insert into ${inventoryCounts} (kind, operator_id) values (${input.kind}, ${input.operatorId})
      returning id
    )
    insert into ${inventoryMoves} (ingredient_id, kind, qty_milli, unit_cost_millicents, count_id, operator_id)
    select l.ingredient_id, 'count',
      l.counted - coalesce((select sum(m.qty_milli) from ${inventoryMoves} m where m.ingredient_id = l.ingredient_id), 0),
      i.unit_cost_millicents, c.id, ${input.operatorId}::integer
    from ${intRows(input.lines.map((l) => [l.ingredientId, l.countedMilli]))} as l(ingredient_id, counted)
    join ${ingredients} i on i.id = l.ingredient_id
    cross join c
    returning count_id, ingredient_id, qty_milli
  `);
  await syncStockOuts();
  return {
    countId: rows[0]?.count_id ?? 0,
    moves: rows.map((r) => ({ ingredientId: r.ingredient_id, qtyMilli: r.qty_milli })),
  };
}

const PRICE_ALERT_PCT = 5;

export type PriceChange = { name: string; pct: number };

export async function recordDelivery(input: {
  vendor: string | null;
  operatorId: number | null;
  lines: readonly { ingredientId: number; qtyMilli: number; unitCostMillicents: number }[];
}): Promise<PriceChange[]> {
  const latestCost = new Map(input.lines.map((l) => [l.ingredientId, l.unitCostMillicents]));
  const { rows } = await db.execute<{ name: string; prev: number; next: number }>(sql`
    with prev as (
      select distinct on (m.ingredient_id) m.ingredient_id, m.unit_cost_millicents
      from ${inventoryMoves} m
      where m.kind = 'receive' and m.ingredient_id in (${sql.join([...latestCost.keys()], sql`, `)})
      order by m.ingredient_id, m.id desc
    ), ins as (
      insert into ${inventoryMoves} (ingredient_id, kind, qty_milli, unit_cost_millicents, vendor, operator_id)
      select l.ingredient_id, 'receive', l.qty_milli, l.unit_cost, ${input.vendor}, ${input.operatorId}::integer
      from ${intRows(input.lines.map((l) => [l.ingredientId, l.qtyMilli, l.unitCostMillicents]))}
        as l(ingredient_id, qty_milli, unit_cost)
    ), cost as (
      update ${ingredients} i set unit_cost_millicents = c.unit_cost
      from ${intRows([...latestCost])} as c(ingredient_id, unit_cost)
      where i.id = c.ingredient_id
    )
    select i.name, p.unit_cost_millicents as prev, c.unit_cost as next
    from ${intRows([...latestCost])} as c(ingredient_id, unit_cost)
    join prev p using (ingredient_id)
    join ${ingredients} i on i.id = c.ingredient_id
    order by i.name
  `);
  await syncStockOuts();
  return rows
    .filter((r) => r.prev > 0 && Math.abs(r.next - r.prev) * 100 > PRICE_ALERT_PCT * r.prev)
    .map((r) => ({ name: r.name, pct: Math.round(((r.next - r.prev) * 100) / r.prev) }));
}

export type WasteEntry = {
  id: number;
  name: string;
  baseUnit: BaseUnit;
  qtyMilli: number;
  reason: WasteReason | null;
  valueCents: number;
  createdAt: Date;
};

export async function recentWaste(limit = 20): Promise<WasteEntry[]> {
  const rows = await db
    .select({
      id: inventoryMoves.id,
      name: ingredients.name,
      baseUnit: ingredients.baseUnit,
      qtyMilli: inventoryMoves.qtyMilli,
      reason: inventoryMoves.wasteReason,
      unitCostMillicents: inventoryMoves.unitCostMillicents,
      createdAt: inventoryMoves.createdAt,
    })
    .from(inventoryMoves)
    .innerJoin(ingredients, eq(ingredients.id, inventoryMoves.ingredientId))
    .where(eq(inventoryMoves.kind, "waste"))
    .orderBy(sql`${inventoryMoves.id} desc`)
    .limit(limit);
  return rows.map(({ unitCostMillicents, ...r }) => ({
    ...r,
    qtyMilli: -r.qtyMilli,
    valueCents: milliToCents(-r.qtyMilli, unitCostMillicents),
  }));
}

export type InventoryAlerts = {
  out: { name: string; eightySixed: string }[];
  low: { name: string; onHandMilli: number; baseUnit: BaseUnit }[];
};

export async function inventoryAlerts(): Promise<InventoryAlerts> {
  const { rows } = await db.execute<{
    name: string;
    out: boolean;
    eighty_sixed: string;
    on_hand: number;
    base_unit: BaseUnit;
  }>(sql`
    select i.name, s.ingredient_id is not null as out, i.base_unit,
      coalesce((
        select string_agg(n.name, ', ' order by n.k, n.name) from (
          select 0 as k, name from ${menuItems} where id = any(s.menu_item_ids)
          union all
          select 1, name from ${modifiers} where id = any(s.modifier_ids)
        ) n
      ), '') as eighty_sixed,
      coalesce(sum(m.qty_milli), 0)::float8 as on_hand
    from ${ingredients} i
    left join ${stockOuts} s on s.ingredient_id = i.id
    left join ${inventoryMoves} m on m.ingredient_id = i.id
    where s.ingredient_id is not null or (i.is_active and i.low_stock_at_milli is not null)
    group by i.id, s.ingredient_id
    having s.ingredient_id is not null
      or (bool_or(m.kind in ('receive', 'count')) and coalesce(sum(m.qty_milli), 0) <= i.low_stock_at_milli)
    order by i.storage_area, i.shelf_order, i.name
  `);
  return {
    out: rows.filter((r) => r.out).map((r) => ({ name: r.name, eightySixed: r.eighty_sixed })),
    low: rows
      .filter((r) => !r.out)
      .map((r) => ({ name: r.name, onHandMilli: r.on_hand, baseUnit: r.base_unit })),
  };
}
