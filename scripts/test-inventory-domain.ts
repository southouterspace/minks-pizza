/**
 * Units, topping prices and recipe resolution, checked against literal values.
 * Run: npx tsx scripts/test-inventory-domain.ts
 */
import assert from "node:assert/strict";
import { milliToCents } from "../src/lib/inventory-domain";
import {
  buildRecipeBook,
  costCents,
  orderLineUsage,
  orderUsage,
  plateCost,
  recipeLineFromRow,
  resolveLines,
  type RecipeContext,
} from "../src/lib/recipes";
import { describeChoice, selectionFactorBps, toppingPriceCents } from "../src/lib/toppings";
import { findUnit, formatQty, toMilli } from "../src/lib/units";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

test("toMilli: standard units and packs", () => {
  assert.equal(toMilli(1, "oz"), 28350);
  assert.equal(toMilli(2.5, "lb"), 1133980);
  assert.equal(toMilli(500, "g"), 500000);
  assert.equal(toMilli(1, "fl oz"), 29574);
  assert.equal(toMilli(3, "each"), 3000);
  assert.equal(toMilli(2, "case", [{ name: "case", baseQtyMilli: 9071840 }]), 18143680);
  assert.equal(toMilli(1, "lb", [{ name: "lb", baseQtyMilli: 1 }]), 1);
  assert.throws(() => toMilli(1, "stone"), /Unknown unit "stone"/);
  assert.deepEqual(findUnit("qt"), { name: "qt", baseQtyMilli: 946353 });
});

test("formatQty: US kitchen units", () => {
  assert.equal(formatQty(28350, "g"), "1 oz");
  assert.equal(formatQty(42525, "g"), "1.5 oz");
  assert.equal(formatQty(453592, "g"), "1 lb");
  assert.equal(formatQty(2267960, "g"), "5 lb");
  assert.equal(formatQty(-14175, "g"), "-0.5 oz");
  assert.equal(formatQty(0, "g"), "0 oz");
  assert.equal(formatQty(946353, "ml"), "1 qt");
  assert.equal(formatQty(7570824, "ml"), "2 gal");
  assert.equal(formatQty(59148, "ml"), "2 fl oz");
  assert.equal(formatQty(12000, "each"), "12");
  assert.equal(formatQty(1500, "each"), "1.5");
});

const half = { halfToppingPriceBps: 5000 };

test("toppingPriceCents: whole, half, extra, light", () => {
  const pep = { priceDeltaCents: 200, extraPriceDeltaCents: 300 };
  assert.equal(toppingPriceCents(pep, { placement: "whole", portion: "regular" }, half), 200);
  assert.equal(toppingPriceCents(pep, { placement: "left", portion: "regular" }, half), 100);
  assert.equal(toppingPriceCents(pep, { placement: "right", portion: "extra" }, half), 150);
  assert.equal(toppingPriceCents(pep, { placement: "whole", portion: "extra" }, half), 300);
  assert.equal(toppingPriceCents(pep, { placement: "whole", portion: "light" }, half), 200);
  assert.equal(toppingPriceCents(pep, { placement: "left", portion: "light" }, half), 100);
});

test("toppingPriceCents: odd cents round half up, other half shares", () => {
  const mush = { priceDeltaCents: 175, extraPriceDeltaCents: null };
  assert.equal(toppingPriceCents(mush, { placement: "left", portion: "regular" }, half), 88);
  assert.equal(toppingPriceCents(mush, { placement: "left", portion: "regular" }, { halfToppingPriceBps: 6000 }), 105);
  assert.equal(toppingPriceCents({ priceDeltaCents: 125, extraPriceDeltaCents: null }, { placement: "right", portion: "regular" }, half), 63);
  assert.equal(toppingPriceCents(mush, { placement: "whole", portion: "extra" }, half), 175);
});

const portions = { halfPortionBps: 5000, lightPortionBps: 5000, extraPortionBps: 15000 };

test("selectionFactorBps", () => {
  assert.equal(selectionFactorBps({ placement: "whole", portion: "regular" }, portions), 10000);
  assert.equal(selectionFactorBps({ placement: "left", portion: "regular" }, portions), 5000);
  assert.equal(selectionFactorBps({ placement: "whole", portion: "extra" }, portions), 15000);
  assert.equal(selectionFactorBps({ placement: "right", portion: "extra" }, portions), 7500);
  assert.equal(selectionFactorBps({ placement: "left", portion: "light" }, portions), 2500);
});

test("describeChoice", () => {
  assert.equal(describeChoice("Pepperoni", {}), "Pepperoni");
  assert.equal(describeChoice("Pepperoni", { placement: "whole", portion: "regular" }), "Pepperoni");
  assert.equal(describeChoice("Pepperoni", { placement: "left", portion: "extra" }), "Pepperoni (left half, extra)");
  assert.equal(describeChoice("Mushrooms", { portion: "light" }), "Mushrooms (light)");
});

const OZ = 28350;
const LARGE = 30;
const MEDIUM = 20;
const CHEESE_PIZZA = 1;
const PEPPERONI = 101;
const EXTRA_CHEESE = 102;
const NO_ONIONS = 103;
const MOZZ = 7;
const PEP = 8;
const ONION = 9;
const SAUCE = 10;

const book = buildRecipeBook(
  [
    { menuItemId: CHEESE_PIZZA, modifierId: null, sizeModifierId: null, ingredientId: MOZZ, qtyMilli: 6 * OZ },
    { menuItemId: CHEESE_PIZZA, modifierId: null, sizeModifierId: LARGE, ingredientId: MOZZ, qtyMilli: 8 * OZ },
    { menuItemId: CHEESE_PIZZA, modifierId: null, sizeModifierId: null, ingredientId: SAUCE, qtyMilli: 4 * OZ },
    { menuItemId: CHEESE_PIZZA, modifierId: null, sizeModifierId: null, ingredientId: ONION, qtyMilli: 1 * OZ },
    { menuItemId: null, modifierId: PEPPERONI, sizeModifierId: LARGE, ingredientId: PEP, qtyMilli: 3 * OZ },
    { menuItemId: null, modifierId: PEPPERONI, sizeModifierId: MEDIUM, ingredientId: PEP, qtyMilli: 2 * OZ },
    { menuItemId: null, modifierId: EXTRA_CHEESE, sizeModifierId: LARGE, ingredientId: MOZZ, qtyMilli: 4 * OZ },
    { menuItemId: null, modifierId: NO_ONIONS, sizeModifierId: null, ingredientId: ONION, qtyMilli: -1 * OZ },
  ].map(recipeLineFromRow),
);
const ctx: RecipeContext = { book, sizeModifierIds: new Set([MEDIUM, LARGE]), settings: portions };

test("resolveLines: size line beats the size-less line, and only for that size", () => {
  assert.deepEqual(
    [...resolveLines(book, { kind: "item", id: CHEESE_PIZZA }, LARGE)],
    [[MOZZ, 226800], [SAUCE, 113400], [ONION, 28350]],
  );
  assert.deepEqual(
    [...resolveLines(book, { kind: "item", id: CHEESE_PIZZA }, MEDIUM)],
    [[MOZZ, 170100], [SAUCE, 113400], [ONION, 28350]],
  );
  assert.deepEqual([...resolveLines(book, { kind: "modifier", id: PEPPERONI }, MEDIUM)], [[PEP, 56700]]);
  assert.deepEqual([...resolveLines(book, { kind: "modifier", id: PEPPERONI }, null)], []);
  assert.deepEqual([...resolveLines(book, { kind: "modifier", id: 999 }, LARGE)], []);
});

test("the issue's pizza: Large, pepperoni on the left, extra cheese", () => {
  const line = {
    menuItemId: CHEESE_PIZZA,
    quantity: 1,
    modifiers: [
      { modifierId: LARGE },
      { modifierId: PEPPERONI, placement: "left" as const, portion: "regular" as const },
      { modifierId: EXTRA_CHEESE },
    ],
  };
  assert.deepEqual(
    [...orderUsage([line], ctx)],
    [[MOZZ, 340200], [SAUCE, 113400], [ONION, 28350], [PEP, 42525]],
  );
  assert.deepEqual(
    [...orderUsage([{ ...line, quantity: 2 }], ctx)],
    [[MOZZ, 680400], [SAUCE, 226800], [ONION, 56700], [PEP, 85050]],
  );
});

test("portion and placement scale only the modifier's recipe", () => {
  const usage = orderUsage(
    [{ menuItemId: CHEESE_PIZZA, quantity: 1, modifiers: [{ modifierId: LARGE }, { modifierId: PEPPERONI, placement: "right", portion: "extra" }] }],
    ctx,
  );
  assert.equal(usage.get(PEP), 63788);
  assert.equal(usage.get(MOZZ), 226800);
});

test("removals clamp at zero per line and never credit another line", () => {
  const noOnions = { menuItemId: CHEESE_PIZZA, quantity: 1, modifiers: [{ modifierId: MEDIUM }, { modifierId: NO_ONIONS }] };
  assert.equal(orderLineUsage(noOnions, ctx).has(ONION), false);
  const doubleRemoval = { ...noOnions, modifiers: [{ modifierId: MEDIUM }, { modifierId: NO_ONIONS }, { modifierId: NO_ONIONS }] };
  assert.equal(orderLineUsage(doubleRemoval, ctx).has(ONION), false);
  const plain = { menuItemId: CHEESE_PIZZA, quantity: 1, modifiers: [{ modifierId: MEDIUM }] };
  assert.equal(orderUsage([doubleRemoval, plain], ctx).get(ONION), 28350);
});

test("a line without a size uses the size-less lines only", () => {
  assert.deepEqual(
    [...orderUsage([{ menuItemId: CHEESE_PIZZA, quantity: 1, modifiers: [{ modifierId: PEPPERONI }] }], ctx)],
    [[MOZZ, 170100], [SAUCE, 113400], [ONION, 28350]],
  );
  assert.deepEqual([...orderUsage([{ menuItemId: null, quantity: 3, modifiers: [{ groupName: "x" } as { modifierId?: number }] }], ctx)], []);
});

test("costs: millicents per base unit, rounded once", () => {
  assert.equal(milliToCents(340200, 882), 300);
  assert.equal(milliToCents(1000, 60000), 60);
  const unitCosts = new Map([[MOZZ, 882], [PEP, 1213], [SAUCE, 265]]);
  const usage = new Map([[MOZZ, 340200], [PEP, 42525], [SAUCE, 113400], [ONION, 28350]]);
  assert.equal(costCents(usage, unitCosts), 382);
  assert.equal(plateCost(CHEESE_PIZZA, LARGE, [], ctx, unitCosts), 230);
  assert.equal(plateCost(CHEESE_PIZZA, MEDIUM, [PEPPERONI], ctx, unitCosts), 249);
});

console.log(`\n${passed} passed`);
