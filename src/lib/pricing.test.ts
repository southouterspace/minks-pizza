import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { priceLine, withItemDefaults, type MenuItem, type MenuModifier, type PricingPolicy, type Selection, type SizePrice } from "./pricing";

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
  station: "pizza",
  groups: [
    { id: 1, name: "Size", role: "size", minSelect: 0, maxSelect: 1, modifiers: [mod(SMALL, "Small", 0), mod(MEDIUM, "Medium", 300), mod(LARGE, "Large", 600)] },
    { id: 2, name: "Crust", role: "crust", minSelect: 0, maxSelect: 1, modifiers: [mod(DEEP_DISH, "Deep Dish", 200, [{ sizeModifierId: LARGE, priceDeltaCents: 300, extraPriceDeltaCents: null }])] },
    { id: 3, name: "Toppings", role: "topping", minSelect: 0, maxSelect: null, modifiers: toppings },
  ],
});

const average: PricingPolicy = { halfToppingRule: "average", halfToppingPriceBps: 5000, extraToppingBps: 20_000 };
const highest: PricingPolicy = { ...average, halfToppingRule: "highest" };

const size = (modifierId: number): Selection => ({ modifierId, placement: "whole", amount: "regular" });
const pick = (modifierId: number, placement: Selection["placement"] = "whole", amount: Selection["amount"] = "regular"): Selection => ({
  modifierId,
  placement,
  amount,
});

const chargedFor = (selections: Selection[], modifierId: number, policy = average, item = pie()) =>
  priceLine(item, selections, policy).modifiers.find((m) => m.modifierId === modifierId)?.priceDeltaCents;

describe("priceLine with per-size modifier prices", () => {
  it("charges a topping its price on the chosen size", () => {
    const { unitPriceCents } = priceLine(pie(), [size(LARGE), pick(PEPPERONI)], average);
    assert.equal(unitPriceCents, 1000 + 600 + 250);
    assert.equal(chargedFor([size(MEDIUM), pick(PEPPERONI)], PEPPERONI), 200);
  });

  it("falls back to the modifier's own price on a size without one, and with no size", () => {
    assert.equal(chargedFor([size(SMALL), pick(PEPPERONI)], PEPPERONI), 150);
    assert.equal(chargedFor([pick(PEPPERONI)], PEPPERONI), 150);
  });

  it("charges the size's extra price, or the extra multiplier on the size's price", () => {
    assert.equal(chargedFor([size(LARGE), pick(PEPPERONI, "whole", "extra")], PEPPERONI), 450);
    assert.equal(chargedFor([size(MEDIUM), pick(PEPPERONI, "whole", "extra")], PEPPERONI), 400);
  });

  it("charges a default topping's extra over its regular price on the chosen size", () => {
    const toppings = withItemDefaults([pepperoni], [PEPPERONI]);
    assert.equal(chargedFor([size(LARGE), pick(PEPPERONI, "whole", "extra")], PEPPERONI, average, pie(toppings)), 450 - 250);
  });

  it("averages a half topping from its price on the chosen size", () => {
    assert.equal(chargedFor([size(LARGE), pick(PEPPERONI, "left")], PEPPERONI), 125);
  });

  it("picks the dearer half by the chosen size's prices under the highest rule", () => {
    const { unitPriceCents, modifiers } = priceLine(pie(), [size(LARGE), pick(PEPPERONI, "left"), pick(MUSHROOMS, "right")], highest);
    assert.deepEqual(
      modifiers.map((m) => [m.modifierId, m.priceDeltaCents]),
      [[LARGE, 600], [PEPPERONI, 250], [MUSHROOMS, 0]],
    );
    assert.equal(unitPriceCents, 1000 + 600 + 250);
  });

  it("charges an option its price on the chosen size", () => {
    assert.equal(chargedFor([size(LARGE), pick(DEEP_DISH)], DEEP_DISH), 300);
    assert.equal(chargedFor([size(SMALL), pick(DEEP_DISH)], DEEP_DISH), 200);
  });

  it("prices the same whether the size is picked before or after the toppings", () => {
    const sizeFirst = priceLine(pie(), [size(LARGE), pick(PEPPERONI, "left", "extra"), pick(DEEP_DISH)], average);
    const sizeLast = priceLine(pie(), [pick(PEPPERONI, "left", "extra"), pick(DEEP_DISH), size(LARGE)], average);
    assert.equal(sizeLast.unitPriceCents, sizeFirst.unitPriceCents);
    assert.equal(sizeLast.unitPriceCents, 1000 + 600 + 225 + 300);
  });
});
