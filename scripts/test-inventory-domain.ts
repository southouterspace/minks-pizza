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
  type UsageModifier,
} from "../src/lib/recipes";
import { describeChoice, priceLine, type LineModifier, type MenuItem, type PricingPolicy } from "../src/lib/pricing";
import { selectionFactorBps } from "../src/lib/recipes";
import { formatQty } from "../src/lib/units";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

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

const half: PricingPolicy = { halfToppingRule: "average", halfToppingPriceBps: 5000, extraToppingBps: 20_000 };
const pie: MenuItem = {
  id: 1,
  name: "Pie",
  description: null,
  basePriceCents: 1000,
  isAvailable: true,
  station: "pizza",
  groups: [
    {
      id: 1,
      name: "Toppings",
      role: "topping",
      minSelect: 0,
      maxSelect: null,
      modifiers: [
        { id: 1, name: "Pepperoni", priceDeltaCents: 200, extraPriceDeltaCents: 300, isDefault: false, isAvailable: true, sizePrices: [] },
        { id: 2, name: "Mushrooms", priceDeltaCents: 175, extraPriceDeltaCents: null, isDefault: false, isAvailable: true, sizePrices: [] },
        { id: 3, name: "Olives", priceDeltaCents: 125, extraPriceDeltaCents: null, isDefault: false, isAvailable: true, sizePrices: [] },
      ],
    },
  ],
};
const charged = (modifierId: number, placement: "whole" | "left" | "right", amount: "light" | "regular" | "extra", policy = half) =>
  priceLine(pie, [{ modifierId, placement, amount }], policy).modifiers[0].priceDeltaCents;

test("topping price: whole, half, extra at the menu's extra price, light", () => {
  assert.equal(charged(1, "whole", "regular"), 200);
  assert.equal(charged(1, "left", "regular"), 100);
  assert.equal(charged(1, "right", "extra"), 150);
  assert.equal(charged(1, "whole", "extra"), 300);
  assert.equal(charged(1, "whole", "light"), 200);
  assert.equal(charged(1, "left", "light"), 100);
});

test("topping price: odd cents round half up, other half shares, extra without a menu price uses the multiplier", () => {
  assert.equal(charged(2, "left", "regular"), 88);
  assert.equal(charged(2, "left", "regular", { ...half, halfToppingPriceBps: 6000 }), 105);
  assert.equal(charged(3, "right", "regular"), 63);
  assert.equal(charged(2, "whole", "extra"), 350);
  assert.equal(priceLine(pie, [{ modifierId: 1, placement: "left", amount: "extra" }, { modifierId: 2, placement: "right", amount: "regular" }], half).unitPriceCents, 1000 + 150 + 88);
});

const portions = { halfPortionBps: 5000, lightPortionBps: 5000, extraPortionBps: 15000 };

test("selectionFactorBps", () => {
  assert.equal(selectionFactorBps({ placement: "whole", amount: "regular" }, portions), 10000);
  assert.equal(selectionFactorBps({ placement: "left", amount: "regular" }, portions), 5000);
  assert.equal(selectionFactorBps({ placement: "whole", amount: "extra" }, portions), 15000);
  assert.equal(selectionFactorBps({ placement: "right", amount: "extra" }, portions), 7500);
  assert.equal(selectionFactorBps({ placement: "left", amount: "light" }, portions), 2500);
  assert.equal(selectionFactorBps({ placement: "whole", amount: "none" }, portions), 0);
});

const snap = (modifierName: string, placement: "whole" | "left" | "right", amount: "light" | "regular" | "extra" | "none"): LineModifier => ({
  kind: "placed",
  modifierId: 1,
  role: "topping",
  groupName: "Toppings",
  modifierName,
  priceDeltaCents: 0,
  placement,
  amount,
});

test("describeChoice", () => {
  assert.equal(describeChoice({ kind: "option", modifierId: 1, role: "size", groupName: "Size", modifierName: "Large", priceDeltaCents: 0 }), "Large");
  assert.equal(describeChoice(snap("Pepperoni", "whole", "regular")), "Pepperoni");
  assert.equal(describeChoice(snap("Pepperoni", "left", "extra")), "Pepperoni (left half, extra)");
  assert.equal(describeChoice(snap("Mushrooms", "whole", "light")), "Mushrooms (light)");
  assert.equal(describeChoice(snap("Onions", "whole", "none")), "No Onions");
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
const opt = (modifierId: number | null): UsageModifier => ({ kind: "option", modifierId });
const top = (modifierId: number, placement: "whole" | "left" | "right", amount: "light" | "regular" | "extra"): UsageModifier => ({
  kind: "placed",
  modifierId,
  placement,
  amount,
});

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
      opt(LARGE),
      top(PEPPERONI, "left", "regular"),
      opt(EXTRA_CHEESE),
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
    [{ menuItemId: CHEESE_PIZZA, quantity: 1, modifiers: [opt(LARGE), top(PEPPERONI, "right", "extra")] }],
    ctx,
  );
  assert.equal(usage.get(PEP), 63788);
  assert.equal(usage.get(MOZZ), 226800);
});

test("removals clamp at zero per line and never credit another line", () => {
  const noOnions = { menuItemId: CHEESE_PIZZA, quantity: 1, modifiers: [opt(MEDIUM), opt(NO_ONIONS)] };
  assert.equal(orderLineUsage(noOnions, ctx).has(ONION), false);
  const doubleRemoval = { ...noOnions, modifiers: [opt(MEDIUM), opt(NO_ONIONS), opt(NO_ONIONS)] };
  assert.equal(orderLineUsage(doubleRemoval, ctx).has(ONION), false);
  const plain = { menuItemId: CHEESE_PIZZA, quantity: 1, modifiers: [opt(MEDIUM)] };
  assert.equal(orderUsage([doubleRemoval, plain], ctx).get(ONION), 28350);
});

test("a line without a size uses the size-less lines only", () => {
  assert.deepEqual(
    [...orderUsage([{ menuItemId: CHEESE_PIZZA, quantity: 1, modifiers: [opt(PEPPERONI)] }], ctx)],
    [[MOZZ, 170100], [SAUCE, 113400], [ONION, 28350]],
  );
  assert.deepEqual([...orderUsage([{ menuItemId: null, quantity: 3, modifiers: [opt(null)] }], ctx)], []);
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
