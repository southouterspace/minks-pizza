/**
 * POS terminal rules with no DOM and no database: the builder's tap cycle,
 * the draft reducer, local totals and the submit body. Every assertion
 * compares to a literal.
 *
 * Run: npx tsx scripts/test-pos-client.ts
 */
import { cyclePlacement, defaultSelections, tapTopping } from "../src/lib/pos-client/builder";
import { draftLine, draftProblem, draftReducer, draftTotals, emptyDraft, firePlan, lineSummary, toSubmitRequest } from "../src/lib/pos-client/draft";
import type { MenuItem, PricingPolicy } from "../src/lib/pricing";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const mod = (id: number, name: string, priceDeltaCents: number, isDefault = false) => ({
  id,
  name,
  priceDeltaCents,
  isDefault,
  isAvailable: true,
});

const cheese: MenuItem = {
  id: 1,
  name: "Cheese Pizza",
  description: null,
  basePriceCents: 1099,
  isAvailable: true,
  station: "pizza",
  groups: [
    { id: 3, name: "Extra Toppings", role: "topping", minSelect: 0, maxSelect: null, modifiers: [mod(30, "Pepperoni", 175), mod(31, "Mushrooms", 150), mod(32, "Basil", 125, true)] },
    { id: 1, name: "Size", role: "size", minSelect: 1, maxSelect: 1, modifiers: [mod(10, 'Medium 12"', 300, true), mod(11, 'Large 14"', 600)] },
    { id: 2, name: "Crust", role: "crust", minSelect: 1, maxSelect: 1, modifiers: [mod(20, "Hand Tossed", 0, true)] },
  ],
};
const soda: MenuItem = { id: 2, name: "Soda", description: null, basePriceCents: 399, isAvailable: true, station: "counter", groups: [] };
const policy: PricingPolicy = { halfToppingRule: "average", extraToppingBps: 20_000 };
const [pep, mush, basil] = cheese.groups[0].modifiers;

check(
  "a fresh pizza starts with every default",
  defaultSelections(cheese).map((s) => s.modifierId),
  [32, 10, 20],
);

let sel = defaultSelections(cheese);
sel = tapTopping(sel, basil, "whole");
sel = tapTopping(sel, basil, "whole");
sel = tapTopping(sel, basil, "whole");
check("a default topping cycles regular → extra → light → NO", sel.find((s) => s.modifierId === 32)?.amount, "none");
sel = tapTopping(sel, basil, "whole");
check("…and back to regular", sel.find((s) => s.modifierId === 32)?.amount, "regular");

sel = tapTopping([], pep, "left");
check("tapping with Left active adds a left half", sel, [{ modifierId: 30, placement: "left", amount: "regular" }]);
check("tapping it with Right active moves it, not cycles", tapTopping(sel, pep, "right"), [{ modifierId: 30, placement: "right", amount: "regular" }]);
check(
  "an added topping cycles off after light",
  tapTopping(tapTopping(tapTopping(sel, pep, "left"), pep, "left"), pep, "left"),
  [],
);
check("long-press cycles the half", cyclePlacement(sel, pep), [{ modifierId: 30, placement: "right", amount: "regular" }]);

const halves = [
  { modifierId: 11, placement: "whole" as const, amount: "regular" as const },
  { modifierId: 20, placement: "whole" as const, amount: "regular" as const },
  { modifierId: 30, placement: "left" as const, amount: "regular" as const },
  { modifierId: 31, placement: "right" as const, amount: "regular" as const },
];
const line = draftLine(cheese, halves, 2, null, policy, "00000000-0000-4000-8000-000000000001");
check("half-and-half large prices at the average rule", line.unitPriceCents, 1099 + 600 + 163);
check("the line reads like a ticket", lineSummary(line.modifiers), 'Large 14" · Hand Tossed · L: Pepperoni · R: Mushrooms');

let d = emptyDraft();
d = draftReducer(d, { type: "add", lines: [line] });
d = draftReducer(d, { type: "add", lines: [draftLine(soda, [], 1, null, policy)] });
d = draftReducer(d, { type: "add", lines: [draftLine(soda, [], 1, null, policy)] });
check("tapping a plain item twice makes one line of 2", d.lines.map((l) => [l.name, l.quantity]), [["Cheese Pizza", 2], ["Soda", 2]]);
check(
  "walk-in totals: subtotal, 8.25% tax, total",
  draftTotals(d, { taxRateBps: 825, deliveryFeeCents: 399 }),
  { subtotalCents: 4522, taxCents: 373, deliveryFeeCents: 0, totalCents: 4895 },
);
d = draftReducer(d, { type: "repeat", lineId: line.lineId });
check("repeat line adds an identical line with its own id", [d.lines.length, d.lines[1].name, d.lines[1].lineId !== line.lineId], [3, "Cheese Pizza", true]);
d = draftReducer(d, { type: "qty", lineId: d.lines[1].lineId, delta: -2 });
check("stepping a line below 1 removes it", d.lines.length, 2);

const phone = draftReducer(d, { type: "mode", mode: "delivery" });
check("delivery wants the phone first", draftProblem(phone), "Enter the caller's phone number.");
const filled = draftReducer(
  draftReducer(phone, { type: "customer", patch: { phone: "555-010-3333", name: "Pat" } }),
  { type: "address", address: { line1: "9 Elm", line2: null, city: null, zip: "77354" } },
);
check("a complete delivery draft is ready", draftProblem(filled), null);
check(
  "delivery totals add the fee",
  draftTotals(filled, { taxRateBps: 825, deliveryFeeCents: 399 }).totalCents,
  4895 + 399,
);
const req = toSubmitRequest(filled, 30, []);
check(
  "delivery submits as a phone order with the address saved",
  [req.channel, req.fulfillment.kind, req.customer?.saveAddress, req.fire.kind, req.lines.length],
  ["phone", "delivery", true, "now", 2],
);
check(
  "Later fires at ready time minus the quote",
  firePlan({ kind: "later", readyAt: "2026-10-03T23:30:00.000Z" }, 24),
  { fire: { kind: "at", at: "2026-10-03T23:06:00.000Z" }, promisedAt: "2026-10-03T23:30:00.000Z" },
);
check("dine-in needs a table", draftProblem(draftReducer(d, { type: "mode", mode: "dine_in" })), "Enter the table.");

console.log(failures === 0 ? "\nAll POS client checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
