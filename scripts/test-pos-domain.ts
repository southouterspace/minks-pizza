/**
 * POS domain behavior against the real database: pricing, replayable submit,
 * manager approvals, folds, scheduled firing, payment state, split checks
 * and the shift report. Every assertion compares to a literal.
 *
 * Run: npx tsx --env-file=.env.local scripts/test-pos-domain.ts
 * Mutates orders and closes any open shift: point MINKS_DATABASE_URL at a
 * test branch, not production. Expects the seeded menu, demo staff
 * (manager PIN 1234, cashier PIN 5678) and an 8.25% tax rate.
 */
import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { db, employees, operators, orderItems, orders, pinAttempts, storeSettings, tenders } from "../src/db";
import {
  closeShift,
  fireDue,
  getOpenShift,
  getOrderView,
  getPosMenu,
  getSettings,
  mutateOrder,
  openShift,
  recordDrawerEvent,
  submitOrder,
  type MutationResult,
  type SubmitOrderRequest,
} from "../src/lib/orders-server";
import { paymentState, type OrderMutation, type OrderView } from "../src/lib/orders";
import { allocate, priceLine, splitEvenly, type MenuItem, type Selection } from "../src/lib/pricing";
import { checkPin } from "../src/lib/pin";
import type { StaffContext } from "../src/lib/staff";
import { cartLineSchema } from "../src/lib/validation";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

function view(r: MutationResult): OrderView {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.order;
}

async function main() {
  const settings = await getSettings();
  if (settings.taxRateBps !== 825 || settings.discountApprovalCents !== 500) {
    throw new Error("expects the seeded 8.25% tax rate and $5.00 discount threshold");
  }
  const [operator] = await db.select().from(operators).limit(1);
  if (!operator) throw new Error("needs an operator row (run an e2e first or sign up at /admin)");
  const staffRows = await db.select().from(employees);
  const actor = (name: string) => {
    const e = staffRows.find((r) => r.name === name);
    if (!e) throw new Error(`missing demo employee ${name}; run npm run db:seed`);
    return { employeeId: e.id, name: e.name, role: e.role };
  };
  const cashier: StaffContext = { actor: actor("Casey Cashier"), operatorId: operator.id };
  const manager: StaffContext = { actor: actor("Morgan Manager"), operatorId: operator.id };
  await db.delete(pinAttempts).where(eq(pinAttempts.operatorId, operator.id));

  // --- Pricing -------------------------------------------------------------
  const menu = await getPosMenu();
  const items = menu.categories.flatMap((c) => c.items);
  const item = (name: string) => items.find((i) => i.name === name)!;
  const mod = (it: MenuItem, name: string) => it.groups.flatMap((g) => g.modifiers).find((m) => m.name === name)!.id;
  const cheese = item("Cheese Pizza");
  const sel = (name: string, placement: Selection["placement"] = "whole", amount: Selection["amount"] = "regular"): Selection =>
    ({ modifierId: mod(cheese, name), placement, amount });
  const halfAndHalf = [sel('Large 14"'), sel("Hand Tossed"), sel("Pepperoni", "left"), sel("Mushrooms", "right")];

  check("Large Cheese, L Pepperoni / R Mushroom, average rule", priceLine(cheese, halfAndHalf, { halfToppingRule: "average", extraToppingBps: 20_000 }).unitPriceCents, 1862);
  check("same pie, highest-half rule", priceLine(cheese, halfAndHalf, { halfToppingRule: "highest", extraToppingBps: 20_000 }).unitPriceCents, 1874);
  check(
    "extra pepperoni whole costs 2x the topping",
    priceLine(cheese, [sel('Large 14"'), sel("Hand Tossed"), sel("Pepperoni", "whole", "extra")], { halfToppingRule: "average", extraToppingBps: 20_000 }).unitPriceCents,
    2049,
  );
  check(
    "half placement on Size is rejected",
    (() => {
      try {
        priceLine(cheese, [sel('Large 14"', "left"), sel("Hand Tossed")], menu.policy);
        return "priced";
      } catch (e) {
        return (e as Error).message;
      }
    })(),
    'Size on "Cheese Pizza" cannot be split or changed in amount.',
  );
  check(
    "old storefront cart line parses to whole/regular selections",
    cartLineSchema.parse({ itemId: 6, quantity: 1, modifierIds: [3] }),
    { itemId: 6, quantity: 1, notes: null, selections: [{ modifierId: 3, placement: "whole", amount: "regular" }] },
  );

  check("allocate 1000 three ways", allocate(1000, [1, 1, 1]), [334, 333, 333]);
  check("allocate 101 by 1:2", allocate(101, [1, 2]), [34, 67]);
  check("splitEvenly 3700 / 3", splitEvenly(3700, 3), [1234, 1233, 1233]);
  check(
    "allocate shares always sum to the total",
    [9999, 1, 1234, 100].map((t) => allocate(t, [3, 1, 7, 2]).reduce((a, b) => a + b, 0)),
    [9999, 1, 1234, 100],
  );

  // --- Shift for tenders -----------------------------------------------------
  const stale = await getOpenShift();
  if (stale) {
    await closeShift({ shiftId: stale.id, countedCashCents: 0, cardBatchCents: 0, declaredCashTipsCents: 0, notes: "closed by test" }, manager);
  }
  const shiftId = randomUUID();
  check("open shift", await openShift({ shiftId, startingBankCents: 10_000 }, cashier), { ok: true, shiftId });
  check("a second open shift is refused", (await openShift({ shiftId: randomUUID(), startingBankCents: 0 }, cashier)).ok, false);

  const line = (name: string, selections: Selection[], quantity = 1) => ({
    lineId: randomUUID(),
    itemId: item(name).id,
    quantity,
    notes: null,
    selections,
  });
  const walkIn = (lines: SubmitOrderRequest["lines"], extra: Partial<SubmitOrderRequest> = {}): SubmitOrderRequest => ({
    orderId: randomUUID(),
    channel: "walk_in",
    fulfillment: { kind: "pickup" },
    customer: null,
    notes: null,
    fire: { kind: "now" },
    promisedAt: null,
    tipCents: 0,
    lines,
    tenders: [],
    ...extra,
  });

  // --- Replayable submit -----------------------------------------------------
  const twoPies = walkIn([line("Cheese Pizza", halfAndHalf, 2)], {
    tenders: [{ id: randomUUID(), method: "cash", amountCents: 4031, tenderedCents: 5000, tipCents: 0, last4: null }],
  });
  const first = view(await submitOrder(twoPies, { kind: "pos", staff: cashier }));
  await submitOrder(twoPies, { kind: "pos", staff: cashier });
  const third = view(await submitOrder(twoPies, { kind: "pos", staff: cashier }));
  const [orderCount] = await db.select({ n: count() }).from(orders).where(eq(orders.id, twoPies.orderId));
  const [tenderCount] = await db.select({ n: count() }).from(tenders).where(eq(tenders.orderId, twoPies.orderId));
  check("submit replayed twice leaves one order", orderCount.n, 1);
  check("and one tender row", tenderCount.n, 1);
  check("replay returns the same order number", third.number, first.number);
  check("2 half-and-half larges: subtotal, tax, total", [first.totals.subtotalCents, first.totals.taxCents, first.totals.totalCents], [3724, 307, 4031]);
  check("fired walk-in is on the line and paid", [first.status, paymentState(first.totals)], ["new", "paid"]);

  // --- Void after fire needs a manager -------------------------------------
  const knots = line("Garlic Knots (6)", []);
  const pieLine = line("Cheese Pizza", halfAndHalf);
  const dinner = view(await submitOrder(walkIn([pieLine, knots]), { kind: "pos", staff: cashier }));
  check("pie + knots totals", [dinner.totals.subtotalCents, dinner.totals.taxCents, dinner.totals.totalCents], [2461, 203, 2664]);
  const voidKnots: OrderMutation = { kind: "void_line", lineId: knots.lineId, reason: "customer changed mind" };
  check("cashier voiding a sent line needs a manager", await mutateOrder({ orderId: dinner.id, mutation: voidKnots }, cashier), { ok: false, reason: "needs_manager" });
  check("a wrong manager PIN is refused", await mutateOrder({ orderId: dinner.id, mutation: voidKnots, approval: { managerPin: "0000" } }, cashier), { ok: false, reason: "bad_pin" });
  check("the cashier's own PIN is not an approval", await mutateOrder({ orderId: dinner.id, mutation: voidKnots, approval: { managerPin: "5678" } }, cashier), { ok: false, reason: "needs_manager" });
  const voided = view(await mutateOrder({ orderId: dinner.id, mutation: voidKnots, approval: { managerPin: "1234" } }, cashier));
  const knotsView = voided.lines.find((l) => l.lineId === knots.lineId)!;
  check("void records who voided and who approved", [knotsView.voided?.by, knotsView.voided?.approvedBy], [cashier.actor.employeeId, manager.actor.employeeId]);
  check("fold drops the voided line from the totals", [voided.totals.subtotalCents, voided.totals.taxCents, voided.totals.totalCents], [1862, 154, 2016]);
  const replayVoid = view(await mutateOrder({ orderId: dinner.id, mutation: voidKnots, approval: { managerPin: "1234" } }, cashier));
  check("replayed void changes nothing", [replayVoid.totals.totalCents, replayVoid.lines.find((l) => l.lineId === knots.lineId)?.voided?.at], [2016, knotsView.voided?.at]);

  // --- Discount threshold ---------------------------------------------------
  const bigDiscount: OrderMutation = { kind: "discount", id: randomUUID(), lineId: null, cents: 600, reason: "regular" };
  check("discount over $5.00 needs a manager", await mutateOrder({ orderId: dinner.id, mutation: bigDiscount }, cashier), { ok: false, reason: "needs_manager" });
  const discounted = view(await mutateOrder({ orderId: dinner.id, mutation: { kind: "discount", id: randomUUID(), lineId: null, cents: 300, reason: "late" } }, cashier));
  check("discount at or under $5.00 is the cashier's call; tax follows", [discounted.totals.discountCents, discounted.totals.taxCents, discounted.totals.totalCents], [300, 129, 1691]);
  check("comp always needs a manager", await mutateOrder({ orderId: dinner.id, mutation: { kind: "comp", id: randomUUID(), lineId: pieLine.lineId, reason: "burnt" } }, cashier), { ok: false, reason: "needs_manager" });

  // --- Scheduled order is held, then fired by fireDue ------------------------
  const later = new Date(Date.now() + 60 * 60_000);
  const scheduled = view(
    await submitOrder(walkIn([line("Cheese Pizza", [sel('Small 10"'), sel("Hand Tossed")])], { channel: "phone", fire: { kind: "at", at: later.toISOString() } }), { kind: "pos", staff: cashier }),
  );
  check("scheduled order is held with nothing fired", [scheduled.status, scheduled.lines.map((l) => l.firedAt)], ["held", [null]]);
  const water = line("Sparkling Water", []);
  await mutateOrder({ orderId: scheduled.id, mutation: { kind: "add_lines", lines: [water], fire: false } }, cashier);
  const heldVoid = view(await mutateOrder({ orderId: scheduled.id, mutation: { kind: "void_line", lineId: water.lineId, reason: "rang twice" } }, cashier));
  check("an unsent line is voided without a manager", heldVoid.lines.find((l) => l.lineId === water.lineId)?.voided?.approvedBy, null);
  await fireDue(new Date());
  check("fireDue before its time leaves it held", (await getOrderView(scheduled.id))?.status, "held");
  await fireDue(new Date(later.getTime() + 1000));
  const fired = (await getOrderView(scheduled.id))!;
  check("fireDue after its time sends live lines to the kitchen", [fired.status, fired.lines.map((l) => l.firedAt !== null)], ["new", [true, false]]);

  // --- Payment state across partial, paid, refund ----------------------------
  const tab = view(await submitOrder(walkIn([line("Caesar Salad", [sel2("Caesar Salad", "Caesar")])]), { kind: "pos", staff: cashier }));
  function sel2(itemName: string, modName: string): Selection {
    return { modifierId: mod(item(itemName), modName), placement: "whole", amount: "regular" };
  }
  check("salad order total", tab.totals.totalCents, 919);
  check("nothing paid is unpaid", paymentState(tab.totals), "unpaid");
  const tender = (amountCents: number, method: "cash" | "card_external", tipCents = 0): OrderMutation => ({
    kind: "tender",
    tender: { id: randomUUID(), method, amountCents, tenderedCents: method === "cash" ? amountCents : null, tipCents, last4: method === "cash" ? null : "4242" },
  });
  const part = view(await mutateOrder({ orderId: tab.id, mutation: tender(500, "cash") }, cashier));
  check("part payment is partial", [paymentState(part.totals), part.totals.paidCents], ["partial", 500]);
  check("over-tendering the balance is refused", (await mutateOrder({ orderId: tab.id, mutation: tender(1000, "card_external") }, cashier)).ok, false);
  const paid = view(await mutateOrder({ orderId: tab.id, mutation: tender(419, "card_external", 200) }, cashier));
  check("rest on card makes it paid", [paymentState(paid.totals), paid.totals.paidCents], ["paid", 919]);
  const refund: OrderMutation = { kind: "refund", id: randomUUID(), method: "cash", amountCents: 500, reason: "wrong dressing" };
  check("refunds need a manager", await mutateOrder({ orderId: tab.id, mutation: refund }, cashier), { ok: false, reason: "needs_manager" });
  const refunded = view(await mutateOrder({ orderId: tab.id, mutation: refund, approval: { managerPin: "1234" } }, cashier));
  check("refund makes it refunded", [paymentState(refunded.totals), refunded.totals.refundedCents], ["refunded", 500]);

  // --- Tax is snapshotted at submit ------------------------------------------
  const before = view(await submitOrder(walkIn([line("Caesar Salad", [sel2("Caesar Salad", "Caesar")])]), { kind: "pos", staff: cashier }));
  check("salad taxed at 8.25% when placed", [before.totals.taxCents, before.totals.totalCents], [70, 919]);
  await db.update(storeSettings).set({ taxRateBps: 1000 }).where(eq(storeSettings.id, 1));
  try {
    const settledLater = view(await mutateOrder({ orderId: before.id, mutation: tender(919, "cash") }, cashier));
    check("a rate change doesn't re-tax an order tendered later", [settledLater.totals.taxCents, settledLater.totals.totalCents, paymentState(settledLater.totals)], [70, 919, "paid"]);
    const after = view(await submitOrder(walkIn([line("Caesar Salad", [sel2("Caesar Salad", "Caesar")])]), { kind: "pos", staff: cashier }));
    check("an order placed after the change is taxed at 10%", [after.totals.taxCents, after.totals.totalCents], [85, 934]);
  } finally {
    await db.update(storeSettings).set({ taxRateBps: 825 }).where(eq(storeSettings.id, 1));
  }

  // --- Split by item keeps the kitchen ticket -------------------------------
  const wings = line("Chicken Wings (8)", [sel2("Chicken Wings (8)", "BBQ")]);
  const table = view(
    await submitOrder(walkIn([line("Cheese Pizza", [sel('Medium 12"'), sel("Hand Tossed")]), wings], { fulfillment: { kind: "dine_in", table: "4" } }), { kind: "pos", staff: cashier }),
  );
  const childId = randomUUID();
  const split: OrderMutation = { kind: "split_by_item", lineIds: [wings.lineId], newOrderId: childId };
  const parent = view(await mutateOrder({ orderId: table.id, mutation: split }, cashier));
  await mutateOrder({ orderId: table.id, mutation: split }, cashier);
  const child = (await getOrderView(childId))!;
  check("split child keeps the parent's kitchen ticket", child.ticketOrderId, table.id);
  check("wings moved to the child; pizza stays", [child.lines.map((l) => l.name), parent.lines.map((l) => l.name)], [["Chicken Wings (8)"], ["Cheese Pizza"]]);
  check("each check folds its own subtotal", [parent.totals.subtotalCents, child.totals.subtotalCents], [1399, 999]);
  const [childRows] = await db.select({ n: count() }).from(orderItems).where(eq(orderItems.orderId, childId));
  check("replayed split moved nothing twice", childRows.n, 1);

  // --- Kitchen status around ready ----------------------------------------
  await db.update(orderItems).set({ doneAt: new Date() }).where(eq(orderItems.orderId, table.id));
  const ready = view(await mutateOrder({ orderId: table.id, mutation: { kind: "fire", lineIds: "all" } }, cashier));
  check("a check whose fired lines are all done is ready", ready.status, "ready");
  const reopened = view(await mutateOrder({ orderId: table.id, mutation: { kind: "add_lines", lines: [line("Garlic Knots (6)", [])], fire: true } }, cashier));
  check("firing another course onto a ready check puts it back on the line", [reopened.status, reopened.readyAt], ["preparing", null]);
  await db.update(orders).set({ status: "completed", readyAt: null }).where(eq(orders.id, dinner.id));
  const settled = view(await mutateOrder({ orderId: dinner.id, mutation: tender(1691, "cash") }, cashier));
  check("paying for an order completed before the POS leaves it completed", [settled.status, paymentState(settled.totals)], ["completed", "paid"]);

  // --- Drawer and shift close ------------------------------------------------
  check("no-sale needs a manager", await recordDrawerEvent({ id: randomUUID(), kind: "no_sale", cents: 0, reason: null }, cashier), { ok: false, reason: "needs_manager" });
  check("paid-in is the cashier's call", await recordDrawerEvent({ id: randomUUID(), kind: "paid_in", cents: 200, reason: "change" }, cashier), { ok: true });
  check("paid-out with manager PIN", await recordDrawerEvent({ id: randomUUID(), kind: "paid_out", cents: 500, reason: "napkins", approval: { managerPin: "1234" } }, cashier), { ok: true });

  const closeInput = { shiftId, countedCashCents: 15_741, cardBatchCents: 619, declaredCashTipsCents: 0, notes: null };
  check("closing a shift needs a manager", await closeShift(closeInput, cashier), { ok: false, reason: "needs_manager" });
  const closed = await closeShift({ ...closeInput, approval: { managerPin: "1234" } }, cashier);
  if (!closed.ok) throw new Error(JSON.stringify(closed));
  // bank 10000 + cash 4031 + 500 + 919 + 1691 − cash refund 500 + paid in 200 − paid out 500
  check("expected cash vs counted", [closed.report.expectedCashCents, closed.report.cashOverShortCents], [16_341, -600]);
  check("card total includes tips and matches the batch", [closed.report.cardTotalCents, closed.report.cardTipsCents, closed.report.cardOverShortCents], [619, 200, 0]);
  check("voids tally under the employee who voided", closed.report.byEmployee.find((e) => e.employeeId === cashier.actor.employeeId)?.voidCents, 848);
  check("orders still owing are listed", closed.report.unpaidOrders.map((o) => o.id).includes(scheduled.id), true);

  // --- PIN attempt limiting -------------------------------------------------
  for (let i = 0; i < 5; i++) await checkPin("0000", operator.id);
  check("five misses lock the device, even for a good PIN", await checkPin("1234", operator.id), { ok: false, reason: "locked_out" });
  await db.delete(pinAttempts).where(eq(pinAttempts.operatorId, operator.id));
  check("a good PIN unlocks once the lock is cleared", (await checkPin("1234", operator.id)).ok, true);

  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
