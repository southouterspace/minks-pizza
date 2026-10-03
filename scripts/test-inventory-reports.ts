/**
 * The four inventory reports against a real database: a small menu with
 * recipes, orders placed through checkout and completed through the order
 * workflow on store-local days in 2020, a receive, a waste and two counts.
 * Every number is checked against a hand-computed literal. Destructive: run
 * only against a throwaway Neon branch.
 *
 * Run: NODE_PATH=scripts/shims npx tsx --env-file=.env.local scripts/test-inventory-reports.ts
 */
import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
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
  operators,
  orderItems,
  orders,
  storeSettings,
  recipeLines,
} from "../src/db";
import { csvResponse } from "../src/lib/csv";
import { recordMoves } from "../src/lib/inventory";
import {
  attachBps,
  coverageBps,
  extraShareBps,
  foodCostBps,
  foodCostReport,
  halfShareBps,
  lightShareBps,
  marginReport,
  REPORTS,
  toppingMixReport,
  varianceReport,
} from "../src/lib/inventory-reports";
import { createOrder } from "../src/lib/checkout";
import { transitionOrder, type Actor } from "../src/lib/order-writes";
import type { Amount, Placement, Selection } from "../src/lib/pricing";
import { cancelOrder, moveOrder } from "./e2e/harness";

const sel = (modifierId: number, placement: Placement = "whole", amount: Amount = "regular"): Selection => ({ modifierId, placement, amount });

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const G = 1000;
const tag = `R${Date.now().toString(36)}`;

async function main() {
  const [settings] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
  const tz = settings.timezone;
  const [operator] = await db
    .insert(operators)
    .values({ email: `${tag}@minks.example`, passwordHash: "x", name: "Reports Test" })
    .returning();
  const actor: Actor = { name: operator.name, operatorId: operator.id, employeeId: null };

  const [category] = await db.insert(categories).values({ name: `${tag} Pizzas` }).returning();
  const [sizeGroup, crustGroup, toppingGroup] = await db
    .insert(modifierGroups)
    .values([
      { name: `${tag} Size`, role: "size", minSelect: 1, maxSelect: 1, sortOrder: 0 },
      { name: `${tag} Crust`, role: "crust", minSelect: 1, maxSelect: 1, sortOrder: 1 },
      { name: `${tag} Toppings`, role: "topping", minSelect: 0, sortOrder: 2 },
    ])
    .returning();
  const [small, large, garlic, , pepMod, mushMod] = await db
    .insert(modifiers)
    .values([
      { groupId: sizeGroup.id, name: "Small", priceDeltaCents: 0, sortOrder: 0 },
      { groupId: sizeGroup.id, name: "Large", priceDeltaCents: 400, sortOrder: 1 },
      { groupId: crustGroup.id, name: "Garlic crust", priceDeltaCents: 50, isDefault: true },
      { groupId: crustGroup.id, name: "Plain crust", priceDeltaCents: 0 },
      { groupId: toppingGroup.id, name: `${tag} Pepperoni`, priceDeltaCents: 150, extraPriceDeltaCents: 250 },
      { groupId: toppingGroup.id, name: `${tag} Mushroom`, priceDeltaCents: 100 },
    ])
    .returning();
  const [pizza, pepPizza, soda] = await db
    .insert(menuItems)
    .values([
      { categoryId: category.id, name: `${tag} Pizza`, basePriceCents: 1000, sortOrder: 0 },
      { categoryId: category.id, name: `${tag} Pep Pizza`, basePriceCents: 1200, sortOrder: 1 },
      { categoryId: category.id, name: `${tag} Soda`, basePriceCents: 200, sortOrder: 2 },
    ])
    .returning();
  await db.insert(itemModifierGroups).values(
    [pizza, pepPizza].flatMap((item) =>
      [sizeGroup, crustGroup, toppingGroup].map((g, sortOrder) => ({ itemId: item.id, groupId: g.id, sortOrder })),
    ),
  );
  const [mozz, pep, dough] = await db
    .insert(ingredients)
    .values([
      { name: `${tag} Mozzarella`, baseUnit: "g", unitCostMillicents: 1000 },
      { name: `${tag} Pepperoni`, baseUnit: "g", unitCostMillicents: 2000 },
      { name: `${tag} Dough`, baseUnit: "each", unitCostMillicents: 50_000 },
    ])
    .returning();
  const ingredientIds = [mozz.id, pep.id, dough.id];
  await db.insert(recipeLines).values([
    { menuItemId: pizza.id, ingredientId: dough.id, qtyMilli: 1000 },
    { menuItemId: pizza.id, ingredientId: mozz.id, qtyMilli: 200 * G },
    { menuItemId: pizza.id, sizeModifierId: large.id, ingredientId: mozz.id, qtyMilli: 300 * G },
    { menuItemId: pepPizza.id, ingredientId: dough.id, qtyMilli: 1000 },
    { menuItemId: pepPizza.id, ingredientId: mozz.id, qtyMilli: 200 * G },
    { menuItemId: pepPizza.id, sizeModifierId: large.id, ingredientId: mozz.id, qtyMilli: 300 * G },
    { menuItemId: pepPizza.id, ingredientId: pep.id, qtyMilli: 100 * G },
    { modifierId: pepMod.id, sizeModifierId: small.id, ingredientId: pep.id, qtyMilli: 50 * G },
    { modifierId: pepMod.id, sizeModifierId: large.id, ingredientId: pep.id, qtyMilli: 80 * G },
  ]);

  const orderIds: string[] = [];
  const countIds: number[] = [];

  async function count(kind: "full" | "spot", counted: [number, number][]) {
    const [row] = await db.insert(inventoryCounts).values({ kind, operatorId: operator.id }).returning();
    countIds.push(row.id);
    const held = await db
      .select({ id: inventoryMoves.ingredientId, qty: sql<string>`sum(${inventoryMoves.qtyMilli})` })
      .from(inventoryMoves)
      .where(inArray(inventoryMoves.ingredientId, counted.map(([id]) => id)))
      .groupBy(inventoryMoves.ingredientId);
    const onHand = new Map(held.map((h) => [h.id, Number(h.qty)]));
    await recordMoves(
      counted.map(([ingredientId, qty]) => ({
        ingredientId,
        kind: "count" as const,
        qtyMilli: qty - (onHand.get(ingredientId) ?? 0),
        countId: row.id,
      })),
    );
    return row.id;
  }

  async function sell(
    localTime: string,
    lines: Parameters<typeof createOrder>[0]["lines"],
    to: "completed" | "canceled" = "completed",
  ) {
    const order = await createOrder({
      orderType: "pickup",
      customerName: "Reports Test",
      customerPhone: "(555) 010-0100",
      tipCents: 0,
      lines,
    });
    orderIds.push(order.id);
    await db
      .update(orders)
      .set({ placedAt: sql`(${localTime}::timestamp at time zone ${tz})` })
      .where(eq(orders.id, order.id));
    if (to === "completed") {
      await moveOrder(order.id, "ready");
      assert.deepEqual(await transitionOrder({ orderId: order.id, to: "completed", actor }), { ok: true });
    } else {
      await cancelOrder(order.id);
    }
    return order;
  }

  try {
    await db
      .update(storeSettings)
      .set({
        isPublished: true,
        isAcceptingOrders: true,
        pickupEnabled: true,
        halfToppingPriceBps: 5000,
        halfPortionBps: 5000,
        lightPortionBps: 5000,
        extraPortionBps: 15000,
        minMarginBps: 7000,
      })
      .where(eq(storeSettings.id, 1));

    await recordMoves([
      { ingredientId: mozz.id, kind: "receive", qtyMilli: 5000 * G, vendor: "Test Foods" },
      { ingredientId: pep.id, kind: "receive", qtyMilli: 1000 * G, vendor: "Test Foods" },
      { ingredientId: dough.id, kind: "receive", qtyMilli: 20_000, vendor: "Test Foods" },
    ]);
    const countA = await count("full", [[mozz.id, 4900 * G], [pep.id, 1000 * G], [dough.id, 20_000]]);

    const crust = sel(garlic.id);
    const o1 = await sell("2020-03-02 12:00", [
      { itemId: pizza.id, quantity: 2, notes: null, selections: [sel(large.id), crust, sel(pepMod.id)] },
    ]);
    const o2 = await sell("2020-03-02 23:30", [
      {
        itemId: pizza.id,
        quantity: 1,
        notes: null,
        selections: [sel(small.id), crust, sel(pepMod.id, "left", "extra"), sel(mushMod.id, "whole", "light")],
      },
    ]);
    const o3 = await sell("2020-03-03 00:30", [
      { itemId: pizza.id, quantity: 1, notes: null, selections: [sel(large.id), crust, sel(mushMod.id, "right")] },
    ]);
    const o4 = await sell("2020-03-03 18:00", [{ itemId: soda.id, quantity: 1, notes: null, selections: [] }]);
    await sell("2020-03-03 19:00", [{ itemId: soda.id, quantity: 3, notes: null, selections: [] }], "canceled");
    await db.update(orderItems).set({ costCents: null }).where(eq(orderItems.orderId, o4.id));

    await recordMoves([{ ingredientId: mozz.id, kind: "waste", qtyMilli: -50 * G, wasteReason: "burnt" }]);
    await recordMoves([{ ingredientId: mozz.id, kind: "receive", qtyMilli: 2000 * G, vendor: "Test Foods" }]);
    const countB = await count("spot", [[mozz.id, 5700 * G], [pep.id, 800 * G]]);

    await test("checkout priced the scenario as hand-computed", async () => {
      assert.deepEqual(
        [o1.totals.subtotalCents, o2.totals.subtotalCents, o3.totals.subtotalCents, o4.totals.subtotalCents],
        [3200, 1275, 1500, 200],
      );
      const costs = await db
        .select({ orderId: orderItems.orderId, cost: orderItems.costCents })
        .from(orderItems)
        .where(inArray(orderItems.orderId, [o1.id, o2.id, o3.id]));
      assert.deepEqual(
        [o1.id, o2.id, o3.id].map((id) => costs.find((c) => c.orderId === id)?.cost),
        [1020, 325, 350],
      );
    });

    await test("food cost: per store-local day, canceled excluded, unknown cost shown as coverage", async () => {
      const report = await foodCostReport({ from: "2020-03-01", to: "2020-03-03" });
      assert.deepEqual(report.range, { from: "2020-03-01", to: "2020-03-03" });
      assert.deepEqual(report.days, [
        { day: "2020-03-01", orders: 0, netSalesCents: 0, lineSalesCents: 0, costedSalesCents: 0, cogsCents: 0 },
        { day: "2020-03-02", orders: 2, netSalesCents: 4475, lineSalesCents: 4475, costedSalesCents: 4475, cogsCents: 1345 },
        { day: "2020-03-03", orders: 2, netSalesCents: 1700, lineSalesCents: 1700, costedSalesCents: 1500, cogsCents: 350 },
      ]);
      assert.deepEqual(report.total, {
        orders: 4, netSalesCents: 6175, lineSalesCents: 6175, costedSalesCents: 5975, cogsCents: 1695,
      });
      assert.deepEqual(
        [...report.days, report.total].map((r) => [foodCostBps(r), coverageBps(r)]),
        [[null, null], [3006, 10000], [2333, 8824], [2837, 9676]],
      );
    });

    await test("food cost: reversed and malformed ranges resolve", async () => {
      const swapped = await foodCostReport({ from: "2020-03-03", to: "2020-03-02" });
      assert.deepEqual(swapped.range, { from: "2020-03-02", to: "2020-03-03" });
      assert.equal(swapped.total.cogsCents, 1695);
      const bogus = await foodCostReport({ from: "2020-02-30", to: "2020-03-02" });
      assert.deepEqual(bogus.range, { from: "2020-02-25", to: "2020-03-02" });
      assert.equal(bogus.total.netSalesCents, 4475);
    });

    await test("food cost CSV", async () => {
      const csv = await REPORTS[0].csv(new URLSearchParams("from=2020-03-02&to=2020-03-03"));
      assert.equal(csv.filename, "food-cost-2020-03-02-to-2020-03-03.csv");
      assert.deepEqual(csv.header, ["Day", "Orders", "Net sales", "COGS", "Food cost %", "Cost known for % of sales"]);
      assert.deepEqual(csv.rows, [
        ["2020-03-02", 2, "44.75", "13.45", "30.06", "100.00"],
        ["2020-03-03", 2, "17.00", "3.50", "23.33", "88.24"],
        ["Total", 4, "61.75", "16.95", "28.37", "96.76"],
      ]);
    });

    const strip = ({ since, ...row }: Awaited<ReturnType<typeof varianceReport>>["rows"][number]) => ({
      ...row,
      since: since === null ? null : "set",
    });

    await test("variance since the previous count, biggest usage first", async () => {
      const report = await varianceReport({ count: String(countB) });
      assert.equal(report.count?.id, countB);
      assert.equal(report.count?.ingredients, 2);
      assert.deepEqual(report.rows.map(strip), [
        {
          ingredientId: mozz.id, name: `${tag} Mozzarella`, baseUnit: "g", since: "set",
          openingMilli: 4_900_000, receivedMilli: 2_000_000, wastedMilli: 50_000, usageMilli: 1_100_000,
          expectedMilli: 5_750_000, countedMilli: 5_700_000, varianceMilli: -50_000, usageCents: 1100, varianceCents: -50,
        },
        {
          ingredientId: pep.id, name: `${tag} Pepperoni`, baseUnit: "g", since: "set",
          openingMilli: 1_000_000, receivedMilli: 0, wastedMilli: 0, usageMilli: 197_500,
          expectedMilli: 802_500, countedMilli: 800_000, varianceMilli: -2_500, usageCents: 395, varianceCents: -5,
        },
      ]);
      assert.deepEqual([report.usageCents, report.varianceCents], [1495, -55]);
    });

    await test("variance on a first count runs from the first move", async () => {
      const report = await varianceReport({ count: String(countA) });
      assert.deepEqual(report.rows.map(strip), [
        {
          ingredientId: dough.id, name: `${tag} Dough`, baseUnit: "each", since: null,
          openingMilli: 0, receivedMilli: 20_000, wastedMilli: 0, usageMilli: 0,
          expectedMilli: 20_000, countedMilli: 20_000, varianceMilli: 0, usageCents: 0, varianceCents: 0,
        },
        {
          ingredientId: mozz.id, name: `${tag} Mozzarella`, baseUnit: "g", since: null,
          openingMilli: 0, receivedMilli: 5_000_000, wastedMilli: 0, usageMilli: 0,
          expectedMilli: 5_000_000, countedMilli: 4_900_000, varianceMilli: -100_000, usageCents: 0, varianceCents: -100,
        },
        {
          ingredientId: pep.id, name: `${tag} Pepperoni`, baseUnit: "g", since: null,
          openingMilli: 0, receivedMilli: 1_000_000, wastedMilli: 0, usageMilli: 0,
          expectedMilli: 1_000_000, countedMilli: 1_000_000, varianceMilli: 0, usageCents: 0, varianceCents: 0,
        },
      ]);
    });

    await test("variance CSV keeps losses as plain negative numbers", async () => {
      const table = await REPORTS[1].csv(new URLSearchParams(`count=${countB}`));
      assert.equal(table.filename, `variance-count-${countB}.csv`);
      assert.deepEqual(
        table.rows.map((r) => r.map((cell, i) => (i === 2 ? typeof cell : cell))),
        [
          [`${tag} Mozzarella`, "g", "string", 4900, 2000, 50, 1100, 5750, 5700, -50, "11.00", "-0.50"],
          [`${tag} Pepperoni`, "g", "string", 1000, 0, 0, 197.5, 802.5, 800, -2.5, "3.95", "-0.05"],
        ],
      );
      const text = await csvResponse(table.filename, table.header, table.rows).text();
      assert.equal(text.split("\r\n")[1].split(",").slice(3).join(","), "4900,2000,50,1100,5750,5700,-50,11.00,-0.50");
    });

    await test("variance defaults to the latest count; an unknown id falls back to it", async () => {
      assert.equal((await varianceReport({})).count?.id, countB);
      assert.equal((await varianceReport({ count: "999999999" })).count?.id, countB);
    });

    await test("topping mix: attach, half, light and extra per size, quantity-weighted", async () => {
      const report = await toppingMixReport({ from: "2020-03-02", to: "2020-03-03" });
      const mine = report.sizes.filter((s) => s.sizeId === small.id || s.sizeId === large.id);
      assert.deepEqual(
        mine.map((s) => ({
          size: s.size,
          pizzas: s.pizzas,
          rows: s.rows.map((r) => [r.topping, r.withTopping, attachBps(r), halfShareBps(r), lightShareBps(r), extraShareBps(r)]),
        })),
        [
          {
            size: "Small",
            pizzas: 1,
            rows: [
              [`${tag} Mushroom`, 1, 10000, 0, 10000, 0],
              [`${tag} Pepperoni`, 1, 10000, 10000, 0, 10000],
            ],
          },
          {
            size: "Large",
            pizzas: 3,
            rows: [
              [`${tag} Pepperoni`, 2, 6667, 0, 0, 0],
              [`${tag} Mushroom`, 1, 3333, 10000, 0, 0],
            ],
          },
        ],
      );
    });

    await test("margins: price with size and default deltas, plate cost from recipes, flagged under minimum", async () => {
      const report = await marginReport();
      assert.equal(report.minMarginBps, 7000);
      const mine = report.rows.filter((r) => [pizza.id, pepPizza.id, soda.id].includes(r.itemId));
      assert.deepEqual(
        mine.map((r) => [r.item, r.size, r.priceCents, r.plateCostCents, r.marginCents, r.marginBps, r.low]),
        [
          [`${tag} Pizza`, "Small", 1050, 250, 800, 7619, false],
          [`${tag} Pizza`, "Large", 1450, 350, 1100, 7586, false],
          [`${tag} Pep Pizza`, "Small", 1250, 450, 800, 6400, true],
          [`${tag} Pep Pizza`, "Large", 1650, 550, 1100, 6667, true],
          [`${tag} Soda`, null, 200, null, null, null, false],
        ],
      );
    });
  } finally {
    if (orderIds.length) await db.delete(orders).where(inArray(orders.id, orderIds));
    if (countIds.length) await db.delete(inventoryCounts).where(inArray(inventoryCounts.id, countIds));
    await db.delete(inventoryMoves).where(inArray(inventoryMoves.ingredientId, ingredientIds));
    await db.delete(categories).where(eq(categories.id, category.id));
    await db.delete(modifierGroups).where(inArray(modifierGroups.id, [sizeGroup.id, crustGroup.id, toppingGroup.id]));
    await db.delete(recipeLines).where(inArray(recipeLines.ingredientId, ingredientIds));
    await db.delete(ingredients).where(inArray(ingredients.id, ingredientIds));
    await db
      .update(storeSettings)
      .set({
        isPublished: settings.isPublished,
        isAcceptingOrders: settings.isAcceptingOrders,
        pickupEnabled: settings.pickupEnabled,
        halfToppingPriceBps: settings.halfToppingPriceBps,
        halfPortionBps: settings.halfPortionBps,
        lightPortionBps: settings.lightPortionBps,
        extraPortionBps: settings.extraPortionBps,
        minMarginBps: settings.minMarginBps,
      })
      .where(eq(storeSettings.id, 1));
    await db.delete(operators).where(eq(operators.id, operator.id));
  }
  console.log(`\n${passed} passed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
