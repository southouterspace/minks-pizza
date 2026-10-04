/**
 * POS terminal rules with no DOM and no database: the builder's tap cycle,
 * the draft reducer, local totals, the submit body and the Later picker's
 * store-timezone arithmetic. Every assertion
 * compares to a literal.
 *
 * Run: npx tsx scripts/test-pos-client.ts
 */
import { cyclePlacement, defaultSelections, tapTopping } from "../src/lib/pos-client/builder";
import { draftLine, draftProblem, draftReducer, draftTotals, emptyDraft, firePlan, lineSummary, toSubmitRequest, type Draft, type NewOrderDraft } from "../src/lib/pos-client/draft";
import { priceLine, reorderLines, withItemDefaults, type MenuItem, type PricingPolicy } from "../src/lib/pricing";
import { withCounts } from "../src/lib/reports";
import { parseCents } from "../src/lib/money";
import { chargeRows } from "../src/components/pos/totals";
import { formatClockSeconds, formatClock, nextStoreTime, hhmmOf } from "../src/lib/zoned";
import { check, run } from "./e2e/harness";

const mod = (id: number, name: string, priceDeltaCents: number, isDefault = false) => ({
  id,
  name,
  priceDeltaCents,
  extraPriceDeltaCents: null,
  isDefault,
  isAvailable: true,
  sizePrices: [],
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
const policy: PricingPolicy = { halfToppingRule: "average", halfToppingPriceBps: 5000, extraToppingBps: 20_000 };
const [pep, , basil] = cheese.groups[0].modifiers;

run(async () => {
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

  const price = (amount: "regular" | "extra" | "light" | "none", placement: "whole" | "left" = "whole") =>
    priceLine(cheese, [{ modifierId: 10, placement: "whole", amount: "regular" }, { modifierId: 20, placement: "whole", amount: "regular" }, { modifierId: 32, placement, amount }], policy).unitPriceCents;
  check(
    "a topping the pie comes with is in its price; only the extra portion costs",
    [price("regular"), price("light"), price("none"), price("regular", "left"), price("extra")],
    [1399, 1399, 1399, 1399, 1524],
  );
  check(
    "an item's own defaults replace the group's",
    withItemDefaults([mod(1, "Red", 0, true), mod(2, "BBQ", 0)], [2]).map((m) => [m.id, m.isDefault]),
    [[1, false], [2, true]],
  );
  check(
    "with no defaults of its own, an item keeps the group's",
    withItemDefaults([mod(1, "Red", 0, true), mod(2, "BBQ", 0)], []).map((m) => m.isDefault),
    [true, false],
  );

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

  function asNew(d: Draft): NewOrderDraft {
    if (d.kind !== "new") throw new Error(`expected a new-order draft, got ${d.kind}`);
    return d;
  }

  let d: Draft = emptyDraft();
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
  const req = toSubmitRequest(asNew(filled), 30, []);
  check(
    "delivery submits as a phone order with the address saved",
    [req.source, req.fulfillment.kind, req.customer?.saveAddress, req.fire.kind, req.lines.length],
    ["phone", "delivery", true, "now", 2],
  );
  check(
    "Later fires at ready time minus the quote",
    firePlan({ kind: "later", readyAt: "2026-10-03T23:30:00.000Z" }, 24),
    { fire: { kind: "at", at: "2026-10-03T23:06:00.000Z" }, promisedAt: "2026-10-03T23:30:00.000Z" },
  );
  const CHICAGO = "America/Chicago";
  check("Later 18:30 picked at 3 PM Chicago is 18:30 Chicago today", nextStoreTime("18:30", new Date("2026-10-03T20:00:00Z"), CHICAGO).toISOString(), "2026-10-03T23:30:00.000Z");
  check("Later 09:00 picked at 3 PM Chicago rolls to tomorrow morning", nextStoreTime("09:00", new Date("2026-10-03T20:00:00Z"), CHICAGO).toISOString(), "2026-10-04T14:00:00.000Z");
  check("Later 23:45 picked at 11:30 PM Chicago stays on the store's day, not UTC's", nextStoreTime("23:45", new Date("2026-10-04T04:30:00Z"), CHICAGO).toISOString(), "2026-10-04T04:45:00.000Z");
  check("Later 18:00 on the day DST ends uses CST", nextStoreTime("18:00", new Date("2026-11-01T12:00:00Z"), CHICAGO).toISOString(), "2026-11-02T00:00:00.000Z");
  check("the picker shows the store's wall clock", hhmmOf("2026-10-04T04:45:00Z", CHICAGO), "23:45");
  check("times read in the store's zone", formatClock("2026-10-04T04:45:00Z", CHICAGO), "11:45 PM");
  check("the KDS as-of stamp keeps the seconds", formatClockSeconds("2026-10-04T04:45:07Z", CHICAGO), "11:45:07 PM");
  const dineIn = draftReducer(d, { type: "mode", mode: "dine_in" });
  check("dine-in needs a table", draftProblem(dineIn), "Enter the table.");
  const held = draftReducer(dineIn, { type: "schedule", schedule: { kind: "hold" } });
  check("leaving dine-in drops a Hold back to ASAP", asNew(draftReducer(held, { type: "mode", mode: "walk_in" })).schedule, { kind: "asap" });
  check("the order after a dine-in check starts dine-in", asNew(draftReducer(held, { type: "next" })).mode, "dine_in");
  check("the order after a delivery starts walk-in", asNew(draftReducer(filled, { type: "next" })).mode, "walk_in");
  check("the next order is empty with a fresh id", [draftReducer(filled, { type: "next" }).lines.length, asNew(draftReducer(filled, { type: "next" })).orderId !== asNew(filled).orderId], [0, true]);

  let append: Draft = draftReducer(filled, { type: "append_to", target: { orderId: "00000000-0000-4000-8000-0000000000aa", number: 41, label: "Table 4" } });
  check("adding to a check starts with no lines", [append.kind, append.lines.length], ["append", 0]);
  append = draftReducer(append, { type: "customer", patch: { name: "Ignored" } });
  append = draftReducer(append, { type: "add", lines: [draftLine(soda, [], 1, null, policy)] });
  check("an added line needs nothing else and keeps the check's fee", [draftProblem(append), draftTotals(append, { taxRateBps: 825, deliveryFeeCents: 399 })], [null, { subtotalCents: 399, taxCents: 33, deliveryFeeCents: 0, totalCents: 432 }]);
  check("order details can't be set on an added-to check", "customer" in append, false);
  check("done adding goes back to a walk-in order", [draftReducer(append, { type: "next" }).kind, asNew(draftReducer(append, { type: "next" })).mode], ["new", "walk_in"]);

  check(
    "the close preview fills over/short from the counts and leaves an uncounted batch blank",
    withCounts({ expectedCashCents: 24640, cardTotalCents: 1500, cardTipsCents: 200 }, { countedCashCents: 24490, cardBatchCents: null, declaredCashTipsCents: 0 }),
    { expectedCashCents: 24640, cardTotalCents: 1500, cardTipsCents: 200, countedCashCents: 24490, cashOverShortCents: -150, cardBatchCents: null, cardOverShortCents: null, declaredCashTipsCents: 0 },
  );
  const reordered = reorderLines(
    [{ itemId: 1, name: "Cheese Pizza", quantity: 1, notes: null, modifiers: line.modifiers }, { itemId: 99, name: "Calzone", quantity: 1, notes: null, modifiers: [] }],
    [cheese, soda],
    policy,
  );
  check(
    "reorder comes back priced, with its ticket text, ready to drop in the draft",
    [reordered.lines.map((l) => [l.name, l.unitPriceCents, lineSummary(l.modifiers)]), reordered.unavailable],
    [[["Cheese Pizza", 1862, 'Large 14" · Hand Tossed · L: Pepperoni · R: Mushrooms']], [{ name: "Calzone", reason: "No longer on the menu" }]],
  );

  check("typed money parses to cents", ["12.5", "$1,200", "0.07", "1.234", "", ".", "abc"].map(parseCents), [1250, 120000, 7, null, null, null, null]);
  check(
    "a check's charge rows skip a zero fee and sign the discount",
    chargeRows({ subtotalCents: 1699, discountCents: 800, taxCents: 74, deliveryFeeCents: 0, tipCents: 0 }),
    [
      { label: "Subtotal", amount: "$16.99" },
      { label: "Discounts", amount: "−$8.00" },
      { label: "Tax", amount: "$0.74" },
    ],
  );
});
