/**
 * The inventory ledger against a real database: an order placed through
 * checkout, completed, recalled and completed again moves exactly its recipe
 * usage once; a stock-out 86's what uses the ingredient and restocking brings
 * it back. Destructive: run only against a throwaway Neon branch.
 *
 * Run: NODE_PATH=scripts/shims npx tsx --env-file=.env.local scripts/test-inventory-db.ts
 */
import assert from "node:assert/strict";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  categories,
  db,
  ingredients,
  inventoryMoves,
  menuItems,
  itemModifierGroups,
  modifierGroups,
  modifiers,
  operators,
  orderEvents,
  orderItems,
  orders,
  recipeLines,
  stockOuts,
  storeSettings,
} from "../src/db";
import { inventorySyncStatement, onHand, planOrderUsage, recordMoves, syncStockOuts } from "../src/lib/inventory";
import { applyKdsAction } from "../src/lib/kds-server";
import { createOrder } from "../src/lib/orders";
import { transitionOrder, transitionStatement, type Actor } from "../src/lib/order-writes";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const OZ = 28350;
const tag = `T${Date.now().toString(36)}`;

async function salesFor(orderId: string) {
  const rows = await db
    .select({ ingredientId: inventoryMoves.ingredientId, qtyMilli: inventoryMoves.qtyMilli })
    .from(inventoryMoves)
    .where(and(eq(inventoryMoves.orderId, orderId), eq(inventoryMoves.kind, "sale")))
    .orderBy(asc(inventoryMoves.id));
  return rows.map((r) => [r.ingredientId, r.qtyMilli] as const);
}

async function netFor(orderId: string) {
  const net = new Map<number, number>();
  for (const [id, qty] of await salesFor(orderId)) net.set(id, (net.get(id) ?? 0) + qty);
  return [...net].toSorted((a, b) => a[0] - b[0]);
}

async function lineCosts(orderId: string) {
  const rows = await db
    .select({ costCents: orderItems.costCents })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));
  return rows.map((r) => r.costCents);
}

async function available(table: typeof menuItems | typeof modifiers, id: number) {
  const [row] = await db.select({ ok: table.isAvailable }).from(table).where(eq(table.id, id));
  return row.ok;
}

async function main() {
  const [settings] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
  const groups = await db.select().from(modifierGroups);
  const mods = await db.select().from(modifiers);
  const group = (name: string) => groups.find((g) => g.name === name)!;
  const pick = (groupName: string, modName: string) =>
    mods.find((m) => m.groupId === group(groupName).id && m.name === modName)!;
  const large = pick("Size", 'Large 14"');
  const handTossed = pick("Crust", "Hand Tossed");

  const [category] = await db.select().from(categories).where(eq(categories.name, "Build Your Own"));
  const [cheesePizza, pepClassic] = await db
    .insert(menuItems)
    .values([
      { categoryId: category.id, name: `${tag} Pizza`, basePriceCents: 1099 },
      { categoryId: category.id, name: `${tag} Pep Classic`, basePriceCents: 1399 },
    ])
    .returning();
  await db.insert(itemModifierGroups).values(
    [cheesePizza, pepClassic].flatMap((item) =>
      [group("Size"), group("Crust"), group("Extra Toppings")].map((g, sortOrder) => ({
        itemId: item.id,
        groupId: g.id,
        sortOrder,
      })),
    ),
  );
  const [pepMod, extraCheese] = await db
    .insert(modifiers)
    .values([
      { groupId: group("Extra Toppings").id, name: `${tag} Pepperoni`, priceDeltaCents: 175, extraPriceDeltaCents: 300 },
      { groupId: group("Extra Toppings").id, name: `${tag} Extra Cheese`, priceDeltaCents: 200 },
    ])
    .returning();

  const [operator] = await db
    .insert(operators)
    .values({ email: `${tag}@minks.example`, passwordHash: "x", name: "Inventory Test" })
    .returning();
  const actor: Actor = { name: operator.name, operatorId: operator.id };
  const kdsOperator = { id: operator.id, name: operator.name };
  const createdOrders: string[] = [];
  let created: { id: number }[] = [];

  try {
    await db
      .update(storeSettings)
      .set({ isPublished: true, isAcceptingOrders: true, pickupEnabled: true })
      .where(eq(storeSettings.id, 1));
    await db.update(modifierGroups).set({ kind: "size" }).where(eq(modifierGroups.id, group("Size").id));
    await db
      .update(modifierGroups)
      .set({ kind: "toppings" })
      .where(eq(modifierGroups.id, group("Extra Toppings").id));
    created = await db
      .insert(ingredients)
      .values([
        { name: `${tag} Mozzarella`, baseUnit: "g", unitCostMillicents: 882, outAtMilli: null },
        { name: `${tag} Pepperoni`, baseUnit: "g", unitCostMillicents: 1213, outAtMilli: null },
      ])
      .returning({ id: ingredients.id });
    const [mozz, pep] = created.map((r) => r.id);
    await db.insert(recipeLines).values([
      { menuItemId: cheesePizza.id, sizeModifierId: null, ingredientId: mozz, qtyMilli: 6 * OZ },
      { menuItemId: cheesePizza.id, sizeModifierId: large.id, ingredientId: mozz, qtyMilli: 8 * OZ },
      { modifierId: pepMod.id, sizeModifierId: large.id, ingredientId: pep, qtyMilli: 3 * OZ },
      { modifierId: extraCheese.id, sizeModifierId: large.id, ingredientId: mozz, qtyMilli: 4 * OZ },
      { menuItemId: pepClassic.id, sizeModifierId: null, ingredientId: pep, qtyMilli: 2 * OZ },
    ]);
    await recordMoves([
      { ingredientId: mozz, kind: "receive", qtyMilli: 1_000_000 },
      { ingredientId: pep, kind: "receive", qtyMilli: 100_000, vendor: "Test Foods" },
    ]);

    const order = await createOrder({
      orderType: "pickup",
      customerName: "Inventory Test",
      customerPhone: "(555) 010-0000",
      tipCents: 0,
      lines: [
        {
          itemId: cheesePizza.id,
          quantity: 1,
          modifiers: [
            { id: large.id },
            { id: handTossed.id },
            { id: pepMod.id, placement: "left" },
            { id: extraCheese.id },
          ],
        },
      ],
    });
    createdOrders.push(order.id);

    await test("checkout prices a half topping and snapshots the choice", async () => {
      assert.equal(order.subtotalCents, 1099 + 600 + 0 + 88 + 200);
      const [line] = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      assert.deepEqual(line.modifiers, [
        { modifierId: large.id, groupName: "Size", modifierName: 'Large 14"', priceDeltaCents: 600 },
        { modifierId: handTossed.id, groupName: "Crust", modifierName: "Hand Tossed", priceDeltaCents: 0 },
        { modifierId: pepMod.id, groupName: "Extra Toppings", modifierName: `${tag} Pepperoni`, priceDeltaCents: 88, placement: "left", portion: "regular" },
        { modifierId: extraCheese.id, groupName: "Extra Toppings", modifierName: `${tag} Extra Cheese`, priceDeltaCents: 200, placement: "whole", portion: "regular" },
      ]);
      assert.equal(line.costCents, null);
    });

    await test("checkout refuses a half on a non-topping and extra without a price", async () => {
      const base = { orderType: "pickup" as const, customerName: "X", customerPhone: "5550100000", tipCents: 0 };
      await assert.rejects(
        createOrder({ ...base, lines: [{ itemId: cheesePizza.id, quantity: 1, modifiers: [{ id: large.id }, { id: handTossed.id, placement: "left" }] }] }),
        new RegExp(`"Hand Tossed" on "${tag} Pizza" can't be split or portioned`),
      );
      await assert.rejects(
        createOrder({ ...base, lines: [{ itemId: cheesePizza.id, quantity: 1, modifiers: [{ id: large.id }, { id: handTossed.id }, { id: extraCheese.id, portion: "extra" }] }] }),
        new RegExp(`Extra ${tag} Extra Cheese isn't offered on "${tag} Pizza"`),
      );
      const extra = await createOrder({ ...base, lines: [{ itemId: cheesePizza.id, quantity: 1, modifiers: [{ id: large.id }, { id: handTossed.id }, { id: pepMod.id, placement: "right", portion: "extra" }] }] });
      createdOrders.push(extra.id);
      assert.equal(extra.subtotalCents, 1099 + 600 + 150);
    });

    await test("nothing moves before completion", async () => {
      for (const to of ["confirmed", "preparing", "ready"] as const) {
        assert.deepEqual(await transitionOrder({ orderId: order.id, to, actor }), { ok: true });
      }
      assert.deepEqual(await salesFor(order.id), []);
      assert.deepEqual(await lineCosts(order.id), [null]);
    });

    await test("completing depletes the recipe usage once and costs the line", async () => {
      assert.deepEqual(await transitionOrder({ orderId: order.id, to: "completed", actor }), { ok: true });
      assert.deepEqual(await salesFor(order.id), [[mozz, -340200], [pep, -42525]]);
      assert.deepEqual(await lineCosts(order.id), [352]);
      assert.deepEqual([...(await onHand([mozz, pep]))], [[mozz, 659800], [pep, 57475]]);
    });

    await test("running the sync again inserts nothing", async () => {
      await inventorySyncStatement(await planOrderUsage(order.id));
      await inventorySyncStatement(await planOrderUsage(order.id));
      assert.deepEqual(await salesFor(order.id), [[mozz, -340200], [pep, -42525]]);
    });

    await test("a stale double-complete is refused and moves nothing", async () => {
      assert.deepEqual(await transitionOrder({ orderId: order.id, to: "completed", actor }), {
        ok: false,
        reason: "Order is already completed.",
      });
      const [{ rows }] = await db.batch([
        transitionStatement({ orderId: order.id, from: ["ready"], to: "completed", actor, now: new Date() }),
        inventorySyncStatement(await planOrderUsage(order.id)),
      ]);
      assert.equal(rows.length, 0);
      assert.deepEqual(await salesFor(order.id), [[mozz, -340200], [pep, -42525]]);
    });

    await test("KDS recall from completed reverses the sale to net zero", async () => {
      await applyKdsAction({ type: "recall", orderId: order.id }, kdsOperator);
      assert.deepEqual(await salesFor(order.id), [[mozz, -340200], [pep, -42525], [mozz, 340200], [pep, 42525]]);
      assert.deepEqual(await netFor(order.id), [[mozz, 0], [pep, 0]]);
      assert.deepEqual(await lineCosts(order.id), [null]);
    });

    await test("completing again through the KDS crosses the threshold and 86's what uses pepperoni", async () => {
      await db.update(ingredients).set({ outAtMilli: 60_000 }).where(eq(ingredients.id, pep));
      assert.deepEqual(await transitionOrder({ orderId: order.id, to: "ready", actor }), { ok: true });
      await applyKdsAction({ type: "handoff", orderId: order.id }, kdsOperator);
      assert.deepEqual(await netFor(order.id), [[mozz, -340200], [pep, -42525]]);
      assert.equal((await salesFor(order.id)).length, 6);
      assert.deepEqual(await lineCosts(order.id), [352]);

      const outs = await db.select().from(stockOuts).where(eq(stockOuts.ingredientId, pep));
      assert.equal(outs.length, 1);
      assert.deepEqual(outs[0].menuItemIds, [pepClassic.id]);
      assert.deepEqual(outs[0].modifierIds, [pepMod.id]);
      assert.equal(await available(menuItems, pepClassic.id), false);
      assert.equal(await available(modifiers, pepMod.id), false);
      assert.equal(await available(menuItems, cheesePizza.id), true);

      const notes = await db
        .select({ actor: orderEvents.actor, note: orderEvents.note })
        .from(orderEvents)
        .where(and(eq(orderEvents.orderId, order.id), eq(orderEvents.type, "note_added")));
      assert.deepEqual(notes, [
        { actor: "Inventory", note: `${tag} Pepperoni ran out · 86'd ${tag} Pep Classic, ${tag} Pepperoni` },
      ]);
    });

    await test("an operator override sticks: a further sale does not re-86", async () => {
      await db.update(menuItems).set({ isAvailable: true }).where(eq(menuItems.id, pepClassic.id));
      const second = await createOrder({
        orderType: "pickup",
        customerName: "Inventory Test 2",
        customerPhone: "(555) 010-0001",
        tipCents: 0,
        lines: [{ itemId: pepClassic.id, quantity: 1, modifiers: [{ id: large.id }, { id: handTossed.id }] }],
      });
      createdOrders.push(second.id);
      for (const to of ["confirmed", "preparing", "ready", "completed"] as const) {
        assert.deepEqual(await transitionOrder({ orderId: second.id, to, actor }), { ok: true });
      }
      assert.deepEqual(await salesFor(second.id), [[pep, -56700]]);
      assert.equal((await onHand([pep])).get(pep), 775);
      assert.equal(await available(menuItems, pepClassic.id), true);
      assert.equal(await available(modifiers, pepMod.id), false);
      assert.equal((await db.select().from(stockOuts).where(eq(stockOuts.ingredientId, pep))).length, 1);
      const notes = await db
        .select({ id: orderEvents.id })
        .from(orderEvents)
        .where(and(eq(orderEvents.orderId, second.id), eq(orderEvents.type, "note_added")));
      assert.deepEqual(notes, []);
    });

    await test("receiving above the threshold restores and clears the stock-out", async () => {
      await recordMoves([{ ingredientId: pep, kind: "receive", qtyMilli: 200_000, vendor: "Test Foods" }]);
      assert.equal((await onHand([pep])).get(pep), 200_775);
      assert.deepEqual(await db.select().from(stockOuts).where(eq(stockOuts.ingredientId, pep)), []);
      assert.equal(await available(modifiers, pepMod.id), true);
      assert.equal(await available(menuItems, pepClassic.id), true);
      assert.deepEqual(await syncStockOuts(), { wentOut: [], restored: [] });
    });

    await test("receive moves default to the ingredient's unit cost", async () => {
      const rows = await db
        .select({ kind: inventoryMoves.kind, qty: inventoryMoves.qtyMilli, cost: inventoryMoves.unitCostMillicents, vendor: inventoryMoves.vendor })
        .from(inventoryMoves)
        .where(and(eq(inventoryMoves.ingredientId, pep), eq(inventoryMoves.kind, "receive")))
        .orderBy(asc(inventoryMoves.id));
      assert.deepEqual(rows, [
        { kind: "receive", qty: 100_000, cost: 1213, vendor: "Test Foods" },
        { kind: "receive", qty: 200_000, cost: 1213, vendor: "Test Foods" },
      ]);
    });

    await test("a never-counted ingredient below its threshold 86's nothing until it is counted", async () => {
      const [basil] = await db
        .insert(ingredients)
        .values({ name: `${tag} Basil`, baseUnit: "g", unitCostMillicents: 3000, outAtMilli: 0 })
        .returning({ id: ingredients.id });
      created.push(basil);
      await db.insert(recipeLines).values({ menuItemId: cheesePizza.id, ingredientId: basil.id, qtyMilli: 5000 });
      await recordMoves([{ ingredientId: basil.id, kind: "sale", qtyMilli: -5000 }]);
      assert.deepEqual(await db.select().from(stockOuts).where(eq(stockOuts.ingredientId, basil.id)), []);
      assert.equal(await available(menuItems, cheesePizza.id), true);

      await recordMoves([{ ingredientId: basil.id, kind: "count", qtyMilli: 5000 }]);
      const [out] = await db.select().from(stockOuts).where(eq(stockOuts.ingredientId, basil.id));
      assert.deepEqual(out.menuItemIds, [cheesePizza.id]);
      assert.equal(await available(menuItems, cheesePizza.id), false);
    });
  } finally {
    const ids = created.map((r) => r.id);
    if (createdOrders.length) await db.delete(orders).where(inArray(orders.id, createdOrders));
    if (ids.length) {
      await db.delete(stockOuts).where(inArray(stockOuts.ingredientId, ids));
      await db.delete(inventoryMoves).where(inArray(inventoryMoves.ingredientId, ids));
      await db.delete(recipeLines).where(inArray(recipeLines.ingredientId, ids));
      await db.delete(ingredients).where(inArray(ingredients.id, ids));
    }
    await db.delete(menuItems).where(inArray(menuItems.id, [cheesePizza.id, pepClassic.id]));
    await db.delete(modifiers).where(inArray(modifiers.id, [pepMod.id, extraCheese.id]));
    await db
      .update(storeSettings)
      .set({
        isPublished: settings.isPublished,
        isAcceptingOrders: settings.isAcceptingOrders,
        pickupEnabled: settings.pickupEnabled,
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
