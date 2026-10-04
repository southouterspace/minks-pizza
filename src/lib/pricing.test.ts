import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { itemOptions, overridesProblem, priceLine, type ItemGroupOverrides, type MenuItem, type MenuModifier, type PricingPolicy, type Selection, type SizePrice } from "./pricing";

const SMALL = 100;
const MEDIUM = 101;
const LARGE = 102;
const DEEP_DISH = 200;
const PEPPERONI = 300;
const MUSHROOMS = 301;

const mod = (id: number, name: string, priceDeltaCents: number, sizePrices: SizePrice[] = []): MenuModifier => ({
  id,
  name,
  priceDeltaCents,
  extraPriceDeltaCents: null,
  isDefault: false,
  isAvailable: true,
  sizePrices,
});

const pepperoni = mod(PEPPERONI, "Pepperoni", 150, [
  { sizeModifierId: MEDIUM, priceDeltaCents: 200, extraPriceDeltaCents: null },
  { sizeModifierId: LARGE, priceDeltaCents: 250, extraPriceDeltaCents: 450 },
]);

const pie = (toppings: MenuModifier[] = [pepperoni, mod(MUSHROOMS, "Mushrooms", 200)]): MenuItem => ({
  id: 1,
  name: "Pie",
  description: null,
  basePriceCents: 1000,
  isAvailable: true,
  isAlcoholic: false,
  station: "pizza",
  groups: [
    { id: 1, name: "Size", role: "size", minSelect: 0, maxSelect: 1, modifiers: [mod(SMALL, "Small", 0), mod(MEDIUM, "Medium", 300), mod(LARGE, "Large", 600)] },
    { id: 2, name: "Crust", role: "crust", minSelect: 0, maxSelect: 1, modifiers: [mod(DEEP_DISH, "Deep Dish", 200, [{ sizeModifierId: LARGE, priceDeltaCents: 300, extraPriceDeltaCents: null }])] },
    { id: 3, name: "Toppings", role: "topping", minSelect: 0, maxSelect: null, modifiers: toppings },
  ],
});

const average: PricingPolicy = { halfToppingRule: "average", halfToppingPriceBps: 5000, extraToppingBps: 20_000 };
const highest: PricingPolicy = { ...average, halfToppingRule: "highest" };

const NONE: ItemGroupOverrides = { defaultModifierIds: [], hiddenModifierIds: [], soldOutModifierIds: [] };

const pick = (modifierId: number, placement: Selection["placement"] = "whole", amount: Selection["amount"] = "regular"): Selection => ({
  modifierId,
  placement,
  amount,
});

const chargedFor = (selections: Selection[], modifierId: number, policy = average, item = pie()) =>
  priceLine(item, selections, policy).modifiers.find((m) => m.modifierId === modifierId)?.priceDeltaCents;

describe("priceLine with per-size modifier prices", () => {
  it("charges a topping its price on the chosen size", () => {
    const { unitPriceCents } = priceLine(pie(), [pick(LARGE), pick(PEPPERONI)], average);
    assert.equal(unitPriceCents, 1000 + 600 + 250);
    assert.equal(chargedFor([pick(MEDIUM), pick(PEPPERONI)], PEPPERONI), 200);
  });

  it("falls back to the modifier's own price on a size without one, and with no size", () => {
    assert.equal(chargedFor([pick(SMALL), pick(PEPPERONI)], PEPPERONI), 150);
    assert.equal(chargedFor([pick(PEPPERONI)], PEPPERONI), 150);
  });

  it("charges the size's extra price, or the extra multiplier on the size's price", () => {
    assert.equal(chargedFor([pick(LARGE), pick(PEPPERONI, "whole", "extra")], PEPPERONI), 450);
    assert.equal(chargedFor([pick(MEDIUM), pick(PEPPERONI, "whole", "extra")], PEPPERONI), 400);
  });

  it("charges a default topping's extra over its regular price on the chosen size", () => {
    const toppings = itemOptions([pepperoni], { ...NONE, defaultModifierIds: [PEPPERONI] });
    assert.equal(chargedFor([pick(LARGE), pick(PEPPERONI, "whole", "extra")], PEPPERONI, average, pie(toppings)), 450 - 250);
  });

  it("averages a half topping from its price on the chosen size", () => {
    assert.equal(chargedFor([pick(LARGE), pick(PEPPERONI, "left")], PEPPERONI), 125);
  });

  it("picks the dearer half by the chosen size's prices under the highest rule", () => {
    const { unitPriceCents, modifiers } = priceLine(pie(), [pick(LARGE), pick(PEPPERONI, "left"), pick(MUSHROOMS, "right")], highest);
    assert.deepEqual(
      modifiers.map((m) => [m.modifierId, m.priceDeltaCents]),
      [[LARGE, 600], [PEPPERONI, 250], [MUSHROOMS, 0]],
    );
    assert.equal(unitPriceCents, 1000 + 600 + 250);
  });

  it("charges an option its price on the chosen size", () => {
    assert.equal(chargedFor([pick(LARGE), pick(DEEP_DISH)], DEEP_DISH), 300);
    assert.equal(chargedFor([pick(SMALL), pick(DEEP_DISH)], DEEP_DISH), 200);
  });

  it("prices the same whether the size is picked before or after the toppings", () => {
    const sizeFirst = priceLine(pie(), [pick(LARGE), pick(PEPPERONI, "left", "extra"), pick(DEEP_DISH)], average);
    const sizeLast = priceLine(pie(), [pick(PEPPERONI, "left", "extra"), pick(DEEP_DISH), pick(LARGE)], average);
    assert.equal(sizeLast.unitPriceCents, sizeFirst.unitPriceCents);
    assert.equal(sizeLast.unitPriceCents, 1000 + 600 + 225 + 300);
  });
});

describe("itemOptions", () => {
  const TWENTY_OZ = 400;
  const TWO_LITER = 401;
  const bottles = [{ ...mod(TWENTY_OZ, "20 oz", 0), isDefault: true }, mod(TWO_LITER, "2 Liter", 100)];
  const drink = (id: number, o: ItemGroupOverrides): MenuItem => ({
    ...pie(),
    id,
    name: `Drink ${id}`,
    groups: [{ id: 9, name: "Bottle Size", role: "size", minSelect: 1, maxSelect: 1, modifiers: itemOptions(bottles, o) }],
  });

  it("leaves every group of the pie exactly as it is when the item overrides nothing", () => {
    const groups = [...pie().groups.map((g) => g.modifiers), bottles, [{ ...pepperoni, isDefault: true, isAvailable: false }]];
    for (const mods of groups) assert.deepEqual(itemOptions(mods, NONE), mods);
  });

  it("drops an option the item hides, and a group default with it", () => {
    assert.deepEqual(itemOptions(bottles, { ...NONE, hiddenModifierIds: [TWO_LITER] }).map((m) => m.id), [TWENTY_OZ]);
    assert.deepEqual(itemOptions(bottles, { ...NONE, hiddenModifierIds: [TWENTY_OZ] }).map((m) => [m.id, m.isDefault]), [[TWO_LITER, false]]);
  });

  it("sells an option out on one item while another item sharing the group still sells it", () => {
    const pepsi = drink(1, { ...NONE, soldOutModifierIds: [TWO_LITER] });
    const starry = drink(2, NONE);
    assert.throws(() => priceLine(pepsi, [pick(TWO_LITER)], average), /no longer available/);
    assert.equal(priceLine(starry, [pick(TWO_LITER)], average).unitPriceCents, 1100);
    assert.equal(priceLine(pepsi, [pick(TWENTY_OZ)], average).unitPriceCents, 1000);
  });

  it("refuses an option the item hides", () => {
    assert.throws(() => priceLine(drink(3, { ...NONE, hiddenModifierIds: [TWO_LITER] }), [pick(TWO_LITER)], average), /no longer available/);
  });
});

describe("overridesProblem", () => {
  const size = { name: "Bottle Size", minSelect: 1, modifiers: [{ id: 1 }, { id: 2 }] };

  it("accepts hiding or selling out an option of the group", () => {
    assert.equal(overridesProblem(size, { ...NONE, hiddenModifierIds: [2], soldOutModifierIds: [1] }), null);
  });

  it("refuses an option from another group", () => {
    assert.match(overridesProblem(size, { ...NONE, soldOutModifierIds: [3] }) ?? "", /isn't in that group/);
  });

  it("refuses hiding an option the item comes with", () => {
    assert.match(overridesProblem(size, { ...NONE, defaultModifierIds: [2], hiddenModifierIds: [2] }) ?? "", /comes with/);
  });

  it("refuses hiding every option of a required group, but not of an optional one", () => {
    assert.match(overridesProblem(size, { ...NONE, hiddenModifierIds: [1, 2] }) ?? "", /required/);
    assert.equal(overridesProblem({ ...size, minSelect: 0 }, { ...NONE, hiddenModifierIds: [1, 2] }), null);
  });
});
