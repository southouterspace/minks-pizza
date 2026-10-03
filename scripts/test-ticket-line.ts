/**
 * KDS ticket layout for structured topping lines and legacy order lines.
 * Run: npx tsx scripts/test-ticket-line.ts
 */
import assert from "node:assert/strict";
import { allDay, ticketLine, type KdsOrder } from "../src/lib/kds";
import type { Amount, LineModifier, OptionRole, Placement, PlaceableRole } from "../src/lib/pricing";

const option = (modifierId: number | null, role: OptionRole, groupName: string, modifierName: string, priceDeltaCents: number): LineModifier => ({
  kind: "option",
  modifierId,
  role,
  groupName,
  modifierName,
  priceDeltaCents,
});
const placed = (
  modifierId: number | null,
  role: PlaceableRole,
  groupName: string,
  modifierName: string,
  priceDeltaCents: number,
  placement: Placement,
  amount: Amount,
): LineModifier => ({ kind: "placed", modifierId, role, groupName, modifierName, priceDeltaCents, placement, amount });

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

test("placed toppings group by placement with their amount", () => {
  assert.deepEqual(
    ticketLine([
      option(1, "size", "Size", 'Large 14"', 600),
      option(5, "crust", "Crust", "Thin Crust", 0),
      placed(9, "topping", "Extra Toppings", "Pepperoni", 150, "left", "extra"),
      placed(12, "topping", "Extra Toppings", "Mushrooms", 100, "right", "regular"),
      placed(17, "topping", "Extra Toppings", "Extra Cheese", 250, "whole", "regular"),
      placed(13, "topping", "Extra Toppings", "Red Onions", 100, "right", "light"),
      placed(20, "sauce", "Sauce", "Marinara", 0, "whole", "none"),
    ]),
    {
      size: 'Large 14"',
      crust: "Thin Crust",
      mods: [],
      toppings: [
        {
          placement: "whole",
          mods: [
            { label: "Extra Cheese", kind: "add" },
            { label: "No Marinara", kind: "remove" },
          ],
        },
        { placement: "left", mods: [{ label: "Extra Pepperoni", kind: "amount" }] },
        {
          placement: "right",
          mods: [
            { label: "Mushrooms", kind: "add" },
            { label: "Light Red Onions", kind: "amount" },
          ],
        },
      ],
    },
  );
});

test("a topping named like an amount is not mistaken for one", () => {
  assert.deepEqual(
    ticketLine([placed(17, "topping", "Extra Toppings", "Extra Cheese", 250, "whole", "regular")]).toppings,
    [{ placement: "whole", mods: [{ label: "Extra Cheese", kind: "add" }] }],
  );
});

test("lines migrated from name-only snapshots (null ids) render by role", () => {
  assert.deepEqual(
    ticketLine([
      option(null, "size", "Size", 'Medium 12"', 300),
      option(null, "crust", "Crust", "Hand Tossed", 0),
      placed(null, "topping", "Extra Toppings", "Pepperoni", 150, "whole", "regular"),
      placed(null, "topping", "Extra Toppings", "Extra Cheese", 250, "whole", "regular"),
      option(null, "option", "Dressing", "Ranch", 0),
    ]),
    {
      size: 'Medium 12"',
      crust: "Hand Tossed",
      mods: [{ label: "Dressing: Ranch", kind: "option" }],
      toppings: [
        {
          placement: "whole",
          mods: [
            { label: "Pepperoni", kind: "add" },
            { label: "Extra Cheese", kind: "add" },
          ],
        },
      ],
    },
  );
});

test("all-day counts still group by item and size for structured lines", () => {
  const pie = (id: number, placement: "whole" | "left") => ({
    id,
    name: "Cheese Pizza",
    quantity: 1,
    station: "pizza" as const,
    notes: null,
    ovenAt: null,
    doneAt: null,
    voidedAt: null,
    modifiers: [option(1, "size", "Size", 'Large 14"', 600), placed(9, "topping", "Extra Toppings", "Pepperoni", 150, placement, "regular")],
  });
  const order: KdsOrder = {
    id: "o1",
    number: 1001,
    status: "new",
    source: "web",
    fulfillment: { kind: "pickup" },
    fireAt: null,
    promisedAt: null,
    customerName: "A",
    customerPhone: "",
    notes: null,
    placedAt: "2026-10-03T12:00:00.000Z",
    readyAt: null,
    items: [pie(1, "whole"), pie(2, "left")],
  };
  assert.deepEqual(allDay([order], "all"), [
    { key: 'Cheese Pizza\u0000Large 14"', name: "Cheese Pizza", size: 'Large 14"', quantity: 2 },
  ]);
});

console.log(`\n${passed} passed`);
