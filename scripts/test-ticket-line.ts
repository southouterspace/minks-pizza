/**
 * KDS ticket layout for structured topping lines and legacy order lines.
 * Run: npx tsx scripts/test-ticket-line.ts
 */
import assert from "node:assert/strict";
import { allDay, ticketLine, type KdsOrder } from "../src/lib/kds";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

test("structured toppings group by placement with portions from the portion field", () => {
  assert.deepEqual(
    ticketLine([
      { modifierId: 1, groupName: "Size", modifierName: 'Large 14"', priceDeltaCents: 600 },
      { modifierId: 5, groupName: "Crust", modifierName: "Thin Crust", priceDeltaCents: 0 },
      { modifierId: 9, groupName: "Extra Toppings", modifierName: "Pepperoni", priceDeltaCents: 150, placement: "left", portion: "extra" },
      { modifierId: 12, groupName: "Extra Toppings", modifierName: "Mushrooms", priceDeltaCents: 100, placement: "right", portion: "regular" },
      { modifierId: 17, groupName: "Extra Toppings", modifierName: "Extra Cheese", priceDeltaCents: 250, placement: "whole", portion: "regular" },
      { modifierId: 13, groupName: "Extra Toppings", modifierName: "Red Onions", priceDeltaCents: 100, placement: "right", portion: "light" },
      { modifierId: 20, groupName: "Sauce", modifierName: "No sauce", priceDeltaCents: 0 },
    ]),
    {
      size: 'Large 14"',
      crust: "Thin Crust",
      mods: [{ label: "No sauce", kind: "remove" }],
      toppings: [
        { placement: "whole", mods: [{ label: "Extra Cheese", kind: "add" }] },
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

test("a structured topping named like an amount is not mistaken for one", () => {
  assert.deepEqual(
    ticketLine([
      { modifierId: 17, groupName: "Extra Toppings", modifierName: "Extra Cheese", priceDeltaCents: 250, placement: "whole", portion: "regular" },
    ]).toppings,
    [{ placement: "whole", mods: [{ label: "Extra Cheese", kind: "add" }] }],
  );
});

test("legacy lines without modifierId render by name exactly as before", () => {
  assert.deepEqual(
    ticketLine([
      { groupName: "Size", modifierName: 'Medium 12"', priceDeltaCents: 300 },
      { groupName: "Crust", modifierName: "Hand Tossed", priceDeltaCents: 0 },
      { groupName: "Extra Toppings", modifierName: "Pepperoni", priceDeltaCents: 150 },
      { groupName: "Extra Toppings", modifierName: "Extra Cheese", priceDeltaCents: 250 },
      { groupName: "Extra Toppings", modifierName: "No onions", priceDeltaCents: 0 },
      { groupName: "Dressing", modifierName: "Ranch", priceDeltaCents: 0 },
    ]),
    {
      size: 'Medium 12"',
      crust: "Hand Tossed",
      mods: [
        { label: "Pepperoni", kind: "add" },
        { label: "Extra Cheese", kind: "amount" },
        { label: "No onions", kind: "remove" },
        { label: "Dressing: Ranch", kind: "option" },
      ],
      toppings: [],
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
    modifiers: [
      { modifierId: 1, groupName: "Size", modifierName: 'Large 14"', priceDeltaCents: 600 },
      { modifierId: 9, groupName: "Extra Toppings", modifierName: "Pepperoni", priceDeltaCents: 150, placement, portion: "regular" as const },
    ],
  });
  const order: KdsOrder = {
    id: "o1",
    number: 1001,
    status: "new",
    type: "pickup",
    customerName: "A",
    customerPhone: "",
    address: null,
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
