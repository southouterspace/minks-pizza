/**
 * The promotions evaluator, checked against literal cents and strings.
 * Run: npx tsx scripts/test-promotions.ts
 */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { zonedDayStart } from "../src/lib/hours";
import { normalizeCode } from "../src/lib/promo-code";
import { EMPTY_DRAFT, fromDraft, promotionTemplates, REWARD_FORM, toDraft, type PromotionDraft, type RewardField } from "../src/lib/promotion-codec";
import {
  customerKeyFromPhone,
  discountedTotals,
  evaluatePromotions,
  inSchedule,
  promotionStatus,
  type EvalLine,
  type EvaluateInput,
  type PromotionCandidate,
  type PromotionTerms,
} from "../src/lib/promotion-engine";
import {
  promotionColumns,
  promotionInputSchema,
  REWARD_TYPES,
  type PromotionInput,
  type PromotionReward,
  type Target,
} from "../src/lib/promotion-schema";
import { dealChangedMessage, describeOffer, describePromotionShort, describeSchedule, nudgeCopy, refusalCopy } from "../src/lib/promotion-copy";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const TZ = "America/Chicago";
const LARGE = 100;
const MEDIUM = 101;
const PIZZAS = 10;
const SIDES = 20;
const CHEESE = 1;
const PEPPERONI = 2;
const KNOTS = 3;

const lines: EvalLine[] = [
  { itemId: CHEESE, categoryId: PIZZAS, modifierIds: [LARGE, 200], quantity: 2, unitPriceCents: 1699 },
  { itemId: PEPPERONI, categoryId: PIZZAS, modifierIds: [LARGE], quantity: 1, unitPriceCents: 1999 },
  { itemId: CHEESE, categoryId: PIZZAS, modifierIds: [MEDIUM], quantity: 1, unitPriceCents: 1399 },
  { itemId: KNOTS, categoryId: SIDES, modifierIds: [], quantity: 1, unitPriceCents: 599 },
];
const SUBTOTAL = 7395;

const names = {
  categories: { [PIZZAS]: "Pizzas", [SIDES]: "Sides" },
  items: { [CHEESE]: "Cheese Pizza", [PEPPERONI]: "Pepperoni", [KNOTS]: "Garlic Knots" },
  modifiers: { [LARGE]: 'Large 14"', [MEDIUM]: 'Medium 12"' },
};

const target = (t: Partial<Target>): Target => ({ categoryIds: [], itemIds: [], modifierIds: [], ...t });

// Tuesday 2026-10-06, 12:00 in Chicago (CDT, UTC-5).
const NOW = new Date("2026-10-06T17:00:00Z");

let nextId = 1;
function promo(reward: PromotionReward, over: Partial<PromotionTerms> = {}): PromotionTerms {
  const id = nextId++;
  return {
    id,
    name: `Promo ${id}`,
    trigger: "automatic",
    reward,
    minSubtotalCents: 0,
    orderTypes: ["pickup", "delivery"],
    startsAt: null,
    endsAt: null,
    schedule: null,
    newCustomersOnly: false,
    perCustomerLimit: null,
    totalLimit: null,
    stackable: false,
    isActive: true,
    archivedAt: null,
    ...over,
  };
}

function auto(p: PromotionTerms, uses = 0, customerUses = 0): PromotionCandidate {
  return { promotion: p, uses, customerUses, code: null };
}

function coded(
  p: PromotionTerms,
  display: string,
  over: { uses?: number; customerUses?: number; maxUses?: number | null; codeUses?: number; codeId?: number } = {},
): PromotionCandidate {
  return {
    promotion: { ...p, trigger: "code" },
    uses: over.uses ?? 0,
    customerUses: over.customerUses ?? 0,
    code: {
      id: over.codeId ?? p.id * 100,
      code: normalizeCode(display),
      display,
      maxUses: over.maxUses ?? null,
      uses: over.codeUses ?? 0,
    },
  };
}

function run(candidates: PromotionCandidate[], over: Partial<EvaluateInput> = {}) {
  return evaluatePromotions({
    lines,
    orderType: "pickup",
    subtotalCents: SUBTOTAL,
    deliveryFeeCents: 0,
    now: NOW,
    timezone: TZ,
    customerKey: null,
    customerHasOrdered: false,
    enteredCodes: candidates.filter((c) => c.code).map((c) => c.code!.code),
    candidates,
    ...over,
  });
}

const amounts = (e: ReturnType<typeof run>) => e.applied.map((a) => a.amountCents);
function reasonFor(e: ReturnType<typeof run>, code: string): string | undefined {
  const r = e.rejected.find((x) => x.code === normalizeCode(code));
  return r && refusalCopy(r.refusal, { display: r.display, timezone: TZ, names });
}

// --- Reward types ------------------------------------------------------------

test("order_percent: 20% of $73.95, and the cap", () => {
  assert.deepEqual(amounts(run([auto(promo({ type: "order_percent", percentBps: 2000, maxDiscountCents: null }))])), [1479]);
  assert.deepEqual(amounts(run([auto(promo({ type: "order_percent", percentBps: 2000, maxDiscountCents: 1000 }))])), [1000]);
});

test("order_amount: $5 off, never more than the items", () => {
  assert.deepEqual(amounts(run([auto(promo({ type: "order_amount", amountCents: 500 }))])), [500]);
  assert.deepEqual(amounts(run([auto(promo({ type: "order_amount", amountCents: 100_000 }))])), [7395]);
});

test("item_percent: 50% off Larges rounds half-up per unit; maxUnits takes the biggest saving", () => {
  const large = target({ modifierIds: [LARGE] });
  assert.deepEqual(amounts(run([auto(promo({ type: "item_percent", target: large, percentBps: 5000, maxUnits: null }))])), [850 + 850 + 1000]);
  assert.deepEqual(amounts(run([auto(promo({ type: "item_percent", target: large, percentBps: 5000, maxUnits: 1 }))])), [1000]);
});

test("item_amount: $3 off sides; $50 off a pizza stops at the unit price", () => {
  assert.deepEqual(amounts(run([auto(promo({ type: "item_amount", target: target({ categoryIds: [SIDES] }), amountCents: 300, maxUnits: null }))])), [300]);
  assert.deepEqual(
    amounts(run([auto(promo({ type: "item_amount", target: target({ itemIds: [PEPPERONI] }), amountCents: 5000, maxUnits: null }))])),
    [1999],
  );
});

test("item_price: any Large $12", () => {
  const large = target({ modifierIds: [LARGE] });
  assert.deepEqual(amounts(run([auto(promo({ type: "item_price", target: large, priceCents: 1200, maxUnits: null }))])), [499 + 499 + 799]);
  assert.deepEqual(amounts(run([auto(promo({ type: "item_price", target: large, priceCents: 1200, maxUnits: 2 }))])), [799 + 499]);
});

test("target needs category AND item AND one of the modifiers", () => {
  const largeCheese = target({ categoryIds: [PIZZAS], itemIds: [CHEESE], modifierIds: [LARGE] });
  assert.deepEqual(amounts(run([auto(promo({ type: "item_amount", target: largeCheese, amountCents: 100, maxUnits: null }))])), [200]);
});

test("bogo: the free unit is the cheapest qualifying one", () => {
  const larges = target({ modifierIds: [LARGE] });
  // Larges at 19.99, 16.99, 16.99: one application, the 16.99 is free.
  assert.deepEqual(
    amounts(run([auto(promo({ type: "bogo", buy: { target: larges, quantity: 1 }, get: { target: larges, quantity: 1, percentBps: 10_000 }, maxApplications: null }))])),
    [1699],
  );
  // Buy 2 get 1 across all pizzas (19.99, 16.99, 16.99, 13.99): the 13.99 is free, the rest can't form a second set.
  const pizzas = target({ categoryIds: [PIZZAS] });
  assert.deepEqual(
    amounts(run([auto(promo({ type: "bogo", buy: { target: pizzas, quantity: 2 }, get: { target: pizzas, quantity: 1, percentBps: 10_000 }, maxApplications: null }))])),
    [1399],
  );
});

test("bogo: buy a pizza, knots half off; a unit is never both buy and get", () => {
  const reward: PromotionReward = {
    type: "bogo",
    buy: { target: target({ categoryIds: [PIZZAS] }), quantity: 1 },
    get: { target: target({ categoryIds: [SIDES] }), quantity: 1, percentBps: 5000 },
    maxApplications: null,
  };
  assert.deepEqual(amounts(run([auto(promo(reward))])), [300]);
  const anything = target({});
  const oneKnot: EvalLine[] = [lines[3]];
  const self = run([auto(promo({ type: "bogo", buy: { target: anything, quantity: 1 }, get: { target: anything, quantity: 1, percentBps: 10_000 }, maxApplications: null }))], {
    lines: oneKnot,
    subtotalCents: 599,
  });
  assert.deepEqual(amounts(self), []);
});

test("bogo: maxApplications caps the sets", () => {
  const four: EvalLine[] = [{ itemId: CHEESE, categoryId: PIZZAS, modifierIds: [LARGE], quantity: 4, unitPriceCents: 1000 }];
  const larges = target({ modifierIds: [LARGE] });
  const reward = (max: number | null): PromotionReward => ({
    type: "bogo",
    buy: { target: larges, quantity: 1 },
    get: { target: larges, quantity: 1, percentBps: 10_000 },
    maxApplications: max,
  });
  assert.deepEqual(amounts(run([auto(promo(reward(null)))], { lines: four, subtotalCents: 4000 })), [2000]);
  assert.deepEqual(amounts(run([auto(promo(reward(1)))], { lines: four, subtotalCents: 4000 })), [1000]);
});

test("free_delivery takes the whole fee and targets delivery", () => {
  const e = run([auto(promo({ type: "free_delivery" }))], { orderType: "delivery", deliveryFeeCents: 499 });
  assert.deepEqual(e.applied.map((a) => [a.amountCents, a.target]), [[499, "delivery"]]);
});

// --- Best deal ---------------------------------------------------------------

test("stackable deals combine when together they beat the best exclusive one", () => {
  const exclusive = promo({ type: "order_percent", percentBps: 2000, maxDiscountCents: null }, { name: "20% off" });
  const larges = promo({ type: "item_price", target: target({ modifierIds: [LARGE] }), priceCents: 1200, maxUnits: null }, { name: "Larges $12", stackable: true });
  const fiver = promo({ type: "order_amount", amountCents: 500 }, { name: "$5 off", stackable: true });
  const e = run([coded(exclusive, "TWENTY"), auto(larges), auto(fiver)]);
  assert.deepEqual(e.applied.map((a) => [a.label, a.amountCents]), [["Larges $12", 1797], ["$5 off", 500]]);
  assert.equal(e.discountCents, 2297);
  assert.equal(reasonFor(e, "TWENTY"), "A better deal is already applied: Larges $12 + $5 off");
});

test("an exclusive deal wins when it beats the stack", () => {
  const forty = promo({ type: "order_percent", percentBps: 4000, maxDiscountCents: null }, { name: "40% off" });
  const larges = promo({ type: "item_price", target: target({ modifierIds: [LARGE] }), priceCents: 1200, maxUnits: null }, { name: "Larges $12", stackable: true });
  const e = run([coded(forty, "FORTY"), auto(larges)]);
  assert.deepEqual(e.applied.map((a) => [a.label, a.code, a.amountCents]), [["40% off", "FORTY", 2958]]);
  assert.deepEqual(e.rejected, []);
});

test("two exclusive deals: the bigger one applies, the code that lost says why", () => {
  const small = promo({ type: "order_amount", amountCents: 300 }, { name: "$3 off" });
  const big = promo({ type: "order_amount", amountCents: 800 }, { name: "Big Tuesday" });
  const e = run([coded(small, "PIZZA3"), auto(big)]);
  assert.deepEqual(amounts(e), [800]);
  assert.equal(reasonFor(e, "PIZZA3"), "A better deal is already applied: Big Tuesday");
});

test("stacking never takes a unit or the order below zero", () => {
  const allFree = promo({ type: "item_percent", target: target({}), percentBps: 10_000, maxUnits: null }, { stackable: true });
  const fiver = promo({ type: "order_amount", amountCents: 500 }, { stackable: true });
  const pizzaOff = promo({ type: "item_amount", target: target({ categoryIds: [PIZZAS] }), amountCents: 300, maxUnits: null }, { stackable: true });
  const e = run([auto(allFree), auto(fiver), auto(pizzaOff)]);
  assert.equal(e.discountCents, SUBTOTAL);
  assert.deepEqual(amounts(e), [SUBTOTAL]);
});

test("order-level discounts apply to what item deals left", () => {
  const larges = promo({ type: "item_price", target: target({ modifierIds: [LARGE] }), priceCents: 1200, maxUnits: null }, { stackable: true });
  const tenPct = promo({ type: "order_percent", percentBps: 1000, maxDiscountCents: null }, { stackable: true });
  // 10% of (7395 − 1797) = 559.8 → 560.
  assert.deepEqual(amounts(run([auto(tenPct), auto(larges)])), [1797, 560]);
});

// --- Rejections ----------------------------------------------------------------

test("every rejection reason, word for word", () => {
  const base = { type: "order_amount", amountCents: 500 } as const;
  const cases: [PromotionCandidate, Partial<EvaluateInput>, string][] = [
    [coded(promo(base, { startsAt: zonedDayStart("2026-10-10", TZ) }), "SOON"), {}, "Starts Oct 10"],
    [coded(promo(base, { endsAt: zonedDayStart("2026-10-01", TZ) }), "OLD"), {}, "Ended Sep 30"],
    [coded(promo(base, { schedule: [{ days: [2], start: "15:00", end: "18:00" }] }), "HAPPY"), {}, "Valid Tue 3–6 PM"],
    [coded(promo(base, { orderTypes: ["pickup"] }), "GRAB"), { orderType: "delivery", deliveryFeeCents: 499 }, "Pickup orders only"],
    [coded(promo(base, { orderTypes: ["delivery"] }), "DROP"), {}, "Delivery orders only"],
    [coded(promo(base, { minSubtotalCents: SUBTOTAL + 450 }), "PIZZA10"), {}, "Add $4.50 more to use PIZZA10"],
    [
      coded(promo({ type: "item_amount", target: target({ itemIds: [CHEESE], modifierIds: [LARGE] }), amountCents: 200, maxUnits: null }), "BIGCHEESE"),
      { lines: [lines[3]], subtotalCents: 599 },
      'Add a Large 14" Cheese Pizza to use this',
    ],
    [
      coded(promo({ type: "bogo", buy: { target: target({ modifierIds: [LARGE] }), quantity: 1 }, get: { target: target({ modifierIds: [LARGE] }), quantity: 1, percentBps: 10_000 }, maxApplications: null }), "TWOFER"),
      { lines: [lines[3]], subtotalCents: 599 },
      'Add 2 × Large 14" item to use this',
    ],
    [coded(promo(base, { newCustomersOnly: true }), "HELLO"), { customerKey: "5552468135", customerHasOrdered: true }, "New customers only"],
    [coded(promo(base, { perCustomerLimit: 1 }), "ONCE", { customerUses: 1 }), { customerKey: "5552468135" }, "Already used with this phone number"],
    [coded(promo(base, { totalLimit: 50 }), "FIFTY", { uses: 50 }), {}, "This code has been fully redeemed"],
    [coded(promo(base), "MINK-7KQ2-X9", { maxUses: 1, codeUses: 1 }), {}, "This code has been fully redeemed"],
    [coded(promo(base, { isActive: false }), "PAUSED"), {}, "This offer has ended"],
    [coded(promo(base, { archivedAt: NOW }), "GONE"), {}, "This offer has ended"],
    [coded(promo({ type: "free_delivery" }), "SHIPIT"), {}, "Delivery orders only"],
  ];
  for (const [c, over, reason] of cases) {
    const e = run([c], over);
    assert.equal(reasonFor(e, c.code!.display), reason, c.code!.display);
    assert.deepEqual(e.applied, []);
  }
  assert.equal(reasonFor(run([], { enteredCodes: ["NOPE"] }), "NOPE"), "We don't recognize that code");
});

test("a deal that changed mid-checkout is named with its reason", () => {
  const p = promo({ type: "order_amount", amountCents: 500 }, { totalLimit: 1, perCustomerLimit: 1 });
  const changed = (e: ReturnType<typeof run>) =>
    dealChangedMessage({ display: "E2E-RACE", refusal: e.rejected[0]?.refusal }, 648, { timezone: TZ });
  assert.equal(changed(run([coded(p, "E2E-RACE", { uses: 1 })])), "E2E-RACE was just fully redeemed — your total is now $6.48.");
  assert.equal(
    changed(run([coded(p, "E2E-RACE", { customerUses: 1 })], { customerKey: "5552468135" })),
    "E2E-RACE: Already used with this phone number. Your total is now $6.48. Check it and place your order again.",
  );
  assert.equal(
    changed(run([coded({ ...p, isActive: false }, "E2E-RACE")])),
    "E2E-RACE: This offer has ended. Your total is now $6.48. Check it and place your order again.",
  );
  assert.equal(
    dealChangedMessage({ display: '"Free knots"', refusal: undefined }, 648, { timezone: TZ }),
    '"Free knots": This deal is no longer available. Your total is now $6.48. Check it and place your order again.',
  );
  assert.equal(dealChangedMessage(undefined, 648, { timezone: TZ }), "Your total is now $6.48. Check it and place your order again.");
});

test("hard stops win over fixable reasons", () => {
  const p = promo({ type: "order_amount", amountCents: 500 }, { minSubtotalCents: 100_000, totalLimit: 1 });
  assert.equal(reasonFor(run([coded(p, "BOTH", { uses: 1 })]), "BOTH"), "This code has been fully redeemed");
});

test("phone-based limits wait until there is a phone", () => {
  const p = promo({ type: "order_amount", amountCents: 500 }, { perCustomerLimit: 1, newCustomersOnly: true });
  const e = run([{ ...coded(p, "ONCE"), customerUses: 3 }], { customerKey: null, customerHasOrdered: true });
  assert.deepEqual(amounts(e), [500]);
});

test("two codes for one offer apply it once", () => {
  const p = promo({ type: "order_amount", amountCents: 500 });
  const e = run([coded(p, "ONE"), coded(p, "TWO", { codeId: 999 })]);
  assert.deepEqual(amounts(e), [500]);
  assert.equal(reasonFor(e, "TWO"), "This offer is already applied");
});

test("codes match case-, space- and dash-insensitively", () => {
  assert.equal(normalizeCode(" pizza-10 "), "PIZZA10");
  assert.equal(normalizeCode("Mink 7kq2-x9"), "MINK7KQ2X9");
  const p = promo({ type: "order_amount", amountCents: 500 });
  assert.deepEqual(amounts(run([coded(p, "PIZZA-10")], { enteredCodes: [normalizeCode("pizza 10")] })), [500]);
});

test("customer key is the phone's last ten digits", () => {
  assert.equal(customerKeyFromPhone("+1 (555) 246-8135"), "5552468135");
  assert.equal(customerKeyFromPhone("555.246.8135"), "5552468135");
  assert.equal(customerKeyFromPhone("12"), null);
});

// --- Nudges ------------------------------------------------------------------

test("nudges: an automatic deal short only of its minimum, and a code under its minimum", () => {
  const knots = [lines[3], { ...lines[3], quantity: 2, unitPriceCents: 790 }];
  const sub = 599 + 1580; // 21.79
  const free = promo({ type: "free_delivery" }, { minSubtotalCents: 2500 });
  const wrongDay = promo({ type: "order_amount", amountCents: 100 }, { minSubtotalCents: 2500, schedule: [{ days: [5], start: "11:00", end: "14:00" }] });
  const tenOff = promo({ type: "order_amount", amountCents: 1000 }, { minSubtotalCents: 3000 });
  const e = run([auto(free), auto(wrongDay), coded(tenOff, "PIZZA10")], {
    lines: knots,
    subtotalCents: sub,
    orderType: "delivery",
    deliveryFeeCents: 499,
  });
  assert.deepEqual(e.nudges.map(nudgeCopy), ["Add $3.21 more for free delivery", "Add $8.21 more to use PIZZA10"]);
  assert.equal(reasonFor(e, "PIZZA10"), "Add $8.21 more to use PIZZA10");
});

// --- Schedule and time zones -------------------------------------------------

test("weekly windows on the store's clock, end exclusive", () => {
  const tue = [{ days: [2], start: "15:00", end: "18:00" }];
  assert.equal(inSchedule(tue, new Date("2026-10-06T20:30:00Z"), TZ), true); // 3:30 PM CDT
  assert.equal(inSchedule(tue, new Date("2026-10-06T23:00:00Z"), TZ), false); // 6:00 PM CDT
  assert.equal(inSchedule(tue, new Date("2026-10-06T20:30:00Z"), "America/Los_Angeles"), false); // 1:30 PM PDT
});

test("windows hold across the DST change", () => {
  const sun = [{ days: [0], start: "15:00", end: "18:00" }];
  // Nov 1 2026: clocks fall back, Chicago is UTC-6 by the afternoon.
  assert.equal(inSchedule(sun, new Date("2026-11-01T21:30:00Z"), TZ), true); // 3:30 PM CST
  assert.equal(inSchedule(sun, new Date("2026-11-01T20:30:00Z"), TZ), false); // 2:30 PM CST
  const sat = [{ days: [6], start: "15:00", end: "18:00" }];
  assert.equal(inSchedule(sat, new Date("2026-10-31T20:30:00Z"), TZ), true); // 3:30 PM CDT
  assert.equal(zonedDayStart("2026-11-01", TZ).toISOString(), "2026-11-01T05:00:00.000Z");
  assert.equal(zonedDayStart("2026-11-02", TZ).toISOString(), "2026-11-02T06:00:00.000Z");
  assert.equal(zonedDayStart("2026-03-08", TZ).toISOString(), "2026-03-08T06:00:00.000Z");
  assert.equal(zonedDayStart("2026-03-09", TZ).toISOString(), "2026-03-09T05:00:00.000Z");
});

test("an overnight window belongs to the day it starts", () => {
  const friLate = [{ days: [5], start: "22:00", end: "02:00" }];
  assert.equal(inSchedule(friLate, new Date("2026-10-10T06:00:00Z"), TZ), true); // Sat 1:00 AM CDT
  assert.equal(inSchedule(friLate, new Date("2026-10-11T06:00:00Z"), TZ), false); // Sun 1:00 AM CDT
});

test("schedule words", () => {
  assert.equal(describeSchedule([{ days: [1, 2, 3, 4, 5], start: "11:00", end: "14:00" }]), "Mon–Fri 11 AM–2 PM");
  assert.equal(describeSchedule([{ days: [2, 4], start: "15:00", end: "18:30" }]), "Tue, Thu 3–6:30 PM");
  assert.equal(describeSchedule([{ days: [0, 1, 2, 3, 4, 5, 6], start: "21:00", end: "23:00" }]), "Daily 9–11 PM");
});

// --- Totals, words, status ---------------------------------------------------

test("tax is on items after item discounts; delivery discounts reduce the fee; tips untouched", () => {
  assert.deepEqual(
    discountedTotals({
      subtotalCents: SUBTOTAL,
      deliveryFeeCents: 499,
      tipCents: 500,
      taxRateBps: 825,
      discounts: [
        { amountCents: 1479, target: "items" },
        { amountCents: 499, target: "delivery" },
      ],
    }),
    // tax = 8.25% of 5916 = 488.07 → 488; total = 7395 − 1978 + 488 + 499 + 500.
    { discountCents: 1978, taxCents: 488, totalCents: 6904 },
  );
});

test("offer sentences", () => {
  const p = promo(
    { type: "order_percent", percentBps: 2000, maxDiscountCents: null },
    { trigger: "code", minSubtotalCents: 3000, orderTypes: ["pickup"], perCustomerLimit: 1, endsAt: zonedDayStart("2026-11-01", TZ) },
  );
  assert.equal(describePromotionShort(p), "20% off orders $30+");
  assert.equal(
    describeOffer(p, { timezone: TZ, code: "PIZZA10" }),
    "20% off orders $30+. Pickup orders only. Ends Oct 31. Once per customer. Can't be combined with other offers. Use code PIZZA10.",
  );
  const bogo = promo({
    type: "bogo",
    buy: { target: target({ modifierIds: [LARGE] }), quantity: 1 },
    get: { target: target({ modifierIds: [LARGE] }), quantity: 1, percentBps: 10_000 },
    maxApplications: null,
  });
  assert.equal(describePromotionShort(bogo, names), 'Buy 1 Large 14" item, get 1 free');
});

test("status is derived from the data", () => {
  const p = promo({ type: "free_delivery" });
  const day = (d: string) => zonedDayStart(d, TZ);
  assert.equal(promotionStatus(p, { uses: 0 }, NOW), "active");
  assert.equal(promotionStatus({ ...p, startsAt: day("2026-10-10") }, { uses: 0 }, NOW), "scheduled");
  assert.equal(promotionStatus({ ...p, endsAt: day("2026-10-01") }, { uses: 0 }, NOW), "expired");
  assert.equal(promotionStatus({ ...p, totalLimit: 5 }, { uses: 5 }, NOW), "used_up");
  assert.equal(promotionStatus({ ...p, isActive: false }, { uses: 0 }, NOW), "paused");
  assert.equal(promotionStatus({ ...p, isActive: false, archivedAt: NOW }, { uses: 0 }, NOW), "archived");
});

// --- Operator form codec -----------------------------------------------------

const catalog = {
  categories: [{ id: PIZZAS, name: "Pizzas" }],
  items: [{ id: CHEESE, name: "Cheese Pizza", categoryId: PIZZAS }],
  modifierGroups: [{ id: 1, name: "Size", modifiers: [{ id: MEDIUM, name: 'Medium 12"' }, { id: 102, name: 'X-Large 18"' }, { id: LARGE, name: 'Large 14"' }] }],
};

/** Saves the input the way the admin does, reads it back into a draft, and submits that draft again. */
function roundTrip(input: PromotionInput): PromotionInput {
  const stored = { id: 1, isActive: true, archivedAt: null, ...promotionColumns(input, TZ) };
  return fromDraft(toDraft({ ...stored, description: stored.description, advertised: stored.advertised }, TZ));
}

test("templates fill the form with the reward they name", () => {
  const byLabel = new Map(promotionTemplates(catalog).map((t) => [t.label, fromDraft(t.draft)]));
  const larges = target({ modifierIds: [LARGE] });
  assert.deepEqual(byLabel.get("BOGO")?.reward, {
    type: "bogo",
    buy: { target: larges, quantity: 1 },
    get: { target: larges, quantity: 1, percentBps: 10_000 },
    maxApplications: null,
  });
  assert.deepEqual(byLabel.get("Item deal price")?.reward, { type: "item_price", target: larges, priceCents: 1200, maxUnits: null });
  assert.deepEqual(byLabel.get("$ off order")?.minSubtotalCents, 2500);
  assert.deepEqual(byLabel.get("Free delivery")?.orderTypes, ["delivery"]);
});

test("every template and every reward type survives save and edit unchanged", () => {
  const drafts: PromotionDraft[] = [
    ...promotionTemplates(catalog).map((t) => t.draft),
    { ...EMPTY_DRAFT, name: "Knots 30% off", rewardType: "item_percent", percent: "30", maxUnits: "2", target: target({ categoryIds: [SIDES] }) },
    { ...EMPTY_DRAFT, name: "$3 off pizzas", rewardType: "item_amount", amount: "3.5", target: target({ categoryIds: [PIZZAS] }), startsOn: "2026-10-10", endsOn: "2026-10-31" },
    { ...EMPTY_DRAFT, name: "Pizza, half-off knots", rewardType: "bogo", target: target({ categoryIds: [PIZZAS] }), getSameAsBuy: false, getTarget: target({ itemIds: [KNOTS] }), getPercent: "50", maxApplications: "2" },
    { ...EMPTY_DRAFT, name: "12.5% up to $8", rewardType: "order_percent", percent: "12.5", maxDiscount: "8", perCustomerLimit: "1", totalLimit: "100", newCustomersOnly: true, stackable: true, advertised: false },
  ];
  assert.deepEqual([...new Set(drafts.map((d) => d.rewardType))].sort(), [...REWARD_TYPES].sort());
  for (const d of drafts) {
    const input = fromDraft(d);
    assert.ok(promotionInputSchema.safeParse(input).success, d.name);
    assert.deepEqual(roundTrip(input), input, d.name);
  }
});

test("each reward type's form shows exactly the fields its reward reads", () => {
  const changed: { [K in RewardField]: PromotionDraft[K] } = {
    percent: "7",
    maxDiscount: "7",
    amount: "7",
    price: "7",
    maxUnits: "7",
    buyQty: "7",
    getQty: "7",
    getPercent: "7",
    maxApplications: "7",
    target: target({ itemIds: [KNOTS] }),
    getTarget: target({ itemIds: [KNOTS] }),
  };
  for (const t of REWARD_TYPES) {
    const base: PromotionDraft = { ...EMPTY_DRAFT, rewardType: t, getSameAsBuy: false };
    const read = (Object.keys(changed) as RewardField[]).filter(
      (f) => !isDeepStrictEqual(fromDraft({ ...base, [f]: changed[f] }).reward, fromDraft(base).reward),
    );
    assert.deepEqual(read.sort(), [...REWARD_FORM[t].fields].sort(), t);
  }
});

console.log(`\n${passed} tests passed`);
