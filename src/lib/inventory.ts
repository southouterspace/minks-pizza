import "server-only";
import { eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  db,
  ingredients,
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
import type { InventoryMoveKind, WasteReason } from "@/lib/inventory-domain";
import {
  buildRecipeBook,
  costCents,
  orderLineUsage,
  orderUsage,
  recipeLineFromRow,
  type RecipeContext,
  type UsageLine,
} from "@/lib/recipes";

const EMPTY_PAIRS = sql`select null::integer, null::integer where false`;

/** `(values (a, b), (c, d))` with integer columns, or an empty relation. */
function pairs(rows: readonly (readonly [number, number])[]): SQL {
  if (rows.length === 0) return EMPTY_PAIRS;
  return sql`values ${sql.join(
    rows.map(([a, b]) => sql`(${a}::integer, ${b}::integer)`),
    sql`, `,
  )}`;
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
  return row ?? { halfPortionBps: 5000, lightPortionBps: 5000, extraPortionBps: 15000 };
}

/** What an order would use and cost, computed once so the sync statement can be built synchronously. */
export type OrderUsagePlan = {
  orderId: string;
  /** Ingredient → milli base units, rounded. */
  usage: ReadonlyMap<number, number>;
  /** order_items.id → food cost in cents. */
  lineCosts: readonly (readonly [number, number])[];
};

/** Reads the order's lines, their recipes and current unit costs. */
export async function planOrderUsage(orderId: string): Promise<OrderUsagePlan> {
  const [lines, settings] = await Promise.all([
    db
      .select({
        id: orderItems.id,
        menuItemId: orderItems.menuItemId,
        quantity: orderItems.quantity,
        modifiers: orderItems.modifiers,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId)),
    portionSettings(),
  ]);

  const itemIds = [...new Set(lines.flatMap((l) => (l.menuItemId === null ? [] : [l.menuItemId])))];
  const modifierIds = [
    ...new Set(
      lines.flatMap((l) =>
        l.modifiers.flatMap((m) => (m.modifierId === undefined ? [] : [m.modifierId])),
      ),
    ),
  ];
  const owners = [
    itemIds.length ? inArray(recipeLines.menuItemId, itemIds) : undefined,
    modifierIds.length ? inArray(recipeLines.modifierId, modifierIds) : undefined,
  ].filter((c) => c !== undefined);

  const [recipeRows, sizeRows] = await Promise.all([
    owners.length ? db.select().from(recipeLines).where(or(...owners)) : [],
    modifierIds.length
      ? db
          .select({ id: modifiers.id })
          .from(modifiers)
          .innerJoin(modifierGroups, eq(modifierGroups.id, modifiers.groupId))
          .where(sql`${modifierGroups.kind} = 'size' and ${inArray(modifiers.id, modifierIds)}`)
      : [],
  ]);

  const ctx: RecipeContext = {
    book: buildRecipeBook(recipeRows.map(recipeLineFromRow)),
    sizeModifierIds: new Set(sizeRows.map((r) => r.id)),
    settings,
  };
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
 * status: a completed, unrefunded order holds its full theoretical usage,
 * any other order holds nothing. It reads the status itself, so placed in a
 * `db.batch` right after a status transition it sees that transition, and
 * it only inserts the difference, so running it again changes nothing. It
 * also stamps each line's food cost while the order is completed. Built
 * from a plan rather than an order id because `db.execute` is a thenable:
 * returning it from an async function would run it on the caller's await.
 */
export function inventorySyncStatement({ orderId, usage, lineCosts }: OrderUsagePlan) {
  return db.execute<{ ingredient_id: number; qty_milli: number }>(sql`
    with wanted as (
      select (${orders.status} = 'completed' and ${orders.paymentStatus} <> 'refunded') as active
      from ${orders} where ${orders.id} = ${orderId}
      for update
    ), target as (
      select u.ingredient_id, case when wanted.active then -u.qty_milli else 0 end as qty_milli
      from (${pairs([...usage])}) as u(ingredient_id, qty_milli), wanted
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
      from (${pairs(lineCosts)}) as c(id, cost_cents), wanted
      where ${orderItems.id} = c.id
    )
    select ingredient_id, qty_milli from moved
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

/** Current on hand per ingredient (milli base units), every ingredient present. */
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
  /** Signed: receipts positive, waste negative, counts the variance. */
  qtyMilli: number;
  /** Defaults to the ingredient's current unit cost. */
  unitCostMillicents?: number;
  countId?: number | null;
  wasteReason?: WasteReason | null;
  vendor?: string | null;
  operatorId?: number | null;
};

/** Appends ledger rows, then re-checks stock-outs. */
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
