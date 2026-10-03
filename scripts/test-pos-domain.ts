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
import { submitOrder } from "../src/lib/orders-server/submit";
import { mutateOrder } from "../src/lib/orders-server/mutate";
import { getSettings } from "../src/lib/settings-server";
import { getPosMenu } from "../src/lib/menu-server";
import { getOrderView } from "../src/lib/orders-server/views";
import { fireDue } from "../src/lib/orders-server/folds";
import { closeShift, getOpenShift, openShift, recordDrawerEvent } from "../src/lib/drawer-server";
import {
  channelLabel,
  orderHistory,
  paymentState,
  sourceLabel,
  type OrderSource,
  type Fulfillment,
  type MutationResult,
  type OrderMutation,
  type OrderView,
  type SubmitOrderRequest,
} from "../src/lib/orders";
import { allocate, priceLine, shareByItem, splitEvenly, type MenuItem, type Selection } from "../src/lib/pricing";
import { checkPin } from "../src/lib/pin";
import { localDateOf, dayBounds } from "../src/lib/zoned";
import type { StaffContext } from "../src/lib/staff";
import { cartLineSchema } from "../src/lib/validation";
import { check, run } from "./e2e/harness";


function view(r: MutationResult): OrderView {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.order;
}

run(async () => {
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
    return { employeeId: e.id, name: e.name, access: e.posAccess };
  };
  const cashier: StaffContext = { actor: actor("Casey Cashier"), operatorId: operator.id };
  const manager: StaffContext = { actor: actor("Morgan Manager"), operatorId: operator.id };
  await db.delete(pinAttempts).where(eq(pinAttempts.operatorId, operator.id));

  const menu = await getPosMenu();
  const items = menu.categories.flatMap((c) => c.items);
  const item = (name: string) => items.find((i) => i.name === name)!;
  const mod = (it: MenuItem, name: string) => it.groups.flatMap((g) => g.modifiers).find((m) => m.name === name)!.id;
  const cheese = item("Cheese Pizza");
  const sel = (name: string, placement: Selection["placement"] = "whole", amount: Selection["amount"] = "regular"): Selection =>
    ({ modifierId: mod(cheese, name), placement, amount });
  const halfAndHalf = [sel('Large 14"'), sel("Hand Tossed"), sel("Pepperoni", "left"), sel("Mushrooms", "right")];

  check("Large Cheese, L Pepperoni / R Mushroom, average rule", priceLine(cheese, halfAndHalf, { halfToppingRule: "average", halfToppingPriceBps: 5000, extraToppingBps: 20_000 }).unitPriceCents, 1862);
  check("same pie, highest-half rule", priceLine(cheese, halfAndHalf, { halfToppingRule: "highest", halfToppingPriceBps: 5000, extraToppingBps: 20_000 }).unitPriceCents, 1874);
  const pepperoni = cheese.groups.flatMap((g) => g.modifiers).find((m) => m.name === "Pepperoni")!;
  check(
    "extra pepperoni whole costs the menu's extra price, else 2x the topping",
    priceLine(cheese, [sel('Large 14"'), sel("Hand Tossed"), sel("Pepperoni", "whole", "extra")], { halfToppingRule: "average", halfToppingPriceBps: 5000, extraToppingBps: 20_000 }).unitPriceCents,
    1699 + (pepperoni.extraPriceDeltaCents ?? 350),
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

  check(
    "one $15 pizza shared by 3, a $3 soda each for guests 1 and 2, on a $19.49 balance",
    shareByItem(1949, 3, [
      { cents: 1500, guests: [] },
      { cents: 300, guests: [0] },
      { cents: 300, guests: [1] },
    ]),
    [743, 742, 464],
  );
  check("a pizza shared by guests 1 and 3 only leaves guest 2 at zero", shareByItem(1000, 3, [{ cents: 1000, guests: [0, 2] }]), [500, 0, 500]);
  check("a fully comped check splits the balance evenly", shareByItem(100, 3, [{ cents: 0, guests: [0] }]), [34, 33, 33]);

  const kinds: Fulfillment[] = [{ kind: "pickup" }, { kind: "delivery", address: { line1: "1 Main", line2: null, city: null, zip: "77380" } }, { kind: "dine_in", table: "4" }];
  const channels: OrderSource[] = ["walk_in", "phone", "web"];
  check(
    "badge and placed label for every channel × fulfillment",
    channels.flatMap((c) => kinds.map((f) => `${c}/${f.kind}: ${channelLabel(c, f.kind)} | ${sourceLabel(c, f)}`)),
    [
      "walk_in/pickup: Walk-in | Walk-in",
      "walk_in/delivery: Walk-in | Walk-in, delivery",
      "walk_in/dine_in: Dine-in | Dine-in, table 4",
      "phone/pickup: Phone | Phone, pickup",
      "phone/delivery: Phone | Phone, delivery",
      "phone/dine_in: Dine-in | Dine-in, table 4",
      "web/pickup: Online | Online, pickup",
      "web/delivery: Online | Online, delivery",
      "web/dine_in: Dine-in | Dine-in, table 4",
    ],
  );

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
    source: "walk_in",
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

  const bigDiscount: OrderMutation = { kind: "discount", id: randomUUID(), lineId: null, cents: 600, reason: "regular" };
  check("discount over $5.00 needs a manager", await mutateOrder({ orderId: dinner.id, mutation: bigDiscount }, cashier), { ok: false, reason: "needs_manager" });
  const discounted = view(await mutateOrder({ orderId: dinner.id, mutation: { kind: "discount", id: randomUUID(), lineId: null, cents: 300, reason: "late" } }, cashier));
  check("discount at or under $5.00 is the cashier's call; tax follows", [discounted.totals.discountCents, discounted.totals.taxCents, discounted.totals.totalCents], [300, 129, 1691]);
  check("comp always needs a manager", await mutateOrder({ orderId: dinner.id, mutation: { kind: "comp", id: randomUUID(), lineId: pieLine.lineId, reason: "burnt" } }, cashier), { ok: false, reason: "needs_manager" });

  const later = new Date(Date.now() + 60 * 60_000);
  const scheduled = view(
    await submitOrder(walkIn([line("Cheese Pizza", [sel('Small 10"'), sel("Hand Tossed")])], { source: "phone", fire: { kind: "at", at: later.toISOString() } }), { kind: "pos", staff: cashier }),
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

  const wings = line("Chicken Wings (8)", [sel2("Chicken Wings (8)", "BBQ")]);
  const table = view(
    await submitOrder(walkIn([line("Cheese Pizza", [sel('Medium 12"'), sel("Hand Tossed")]), wings], { fulfillment: { kind: "dine_in", table: "4" } }), { kind: "pos", staff: cashier }),
  );
  check("a dine-in check's log says it was placed dine-in at its table", orderHistory(table)[0].text, "Placed (Dine-in, table 4)");
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

  await db.update(orderItems).set({ doneAt: new Date() }).where(eq(orderItems.orderId, table.id));
  const ready = view(await mutateOrder({ orderId: table.id, mutation: { kind: "fire", lineIds: "all" } }, cashier));
  check("a check whose fired lines are all done is ready", ready.status, "ready");
  const reopened = view(await mutateOrder({ orderId: table.id, mutation: { kind: "add_lines", lines: [line("Garlic Knots (6)", [])], fire: true } }, cashier));
  check("firing another course onto a ready check puts it back on the line", [reopened.status, reopened.readyAt], ["preparing", null]);
  await db.update(orders).set({ status: "completed", readyAt: null }).where(eq(orders.id, dinner.id));
  const settled = view(await mutateOrder({ orderId: dinner.id, mutation: tender(1691, "cash") }, cashier));
  check("paying for an order completed before the POS leaves it completed", [settled.status, paymentState(settled.totals)], ["completed", "paid"]);

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
  const r = closed.report;
  check(
    "sales by channel: orders, net sales, tax",
    r.byChannel.map((c) => [c.channel, c.orders, c.netCents, c.taxCents]),
    [["walk_in", 5, 7833, 661], ["phone", 1, 1099, 91], ["dine_in", 2, 2997, 247], ["web", 0, 0, 0], ["marketplace", 0, 0, 0]],
  );
  check("shift sales total", [r.sales.orders, r.sales.grossCents, r.sales.discountCents, r.sales.totalCents], [8, 12_229, 300, 12_928]);
  check(
    "tenders by method: count, payments, tips, refunds, net",
    r.byMethod.map((m) => [m.method, m.payments, m.paymentCents, m.tipCents, m.refundCents, m.netCents]),
    [["cash", 4, 7141, 0, 500, 6641], ["card_external", 1, 419, 200, 0, 619]],
  );
  const who = (id: number | null) => (id === null ? null : r.staff[id]);
  check(
    "every exception and drawer event, with who, approver and reason",
    r.audit.map((a) => [a.kind, a.item, a.cents, who(a.employeeId), who(a.approvedBy), a.reason]),
    [
      ["void", "1 × Garlic Knots (6)", 599, "Casey Cashier", "Morgan Manager", "customer changed mind"],
      ["discount", null, 300, "Casey Cashier", null, "late"],
      ["void", "1 × Sparkling Water", 249, "Casey Cashier", null, "rang twice"],
      ["refund", null, 500, "Casey Cashier", "Morgan Manager", "wrong dressing"],
      ["paid_in", null, 200, "Casey Cashier", null, "change"],
      ["paid_out", null, 500, "Casey Cashier", "Morgan Manager", "napkins"],
    ],
  );
  check("orders still owing are listed", closed.report.unpaidOrders.map((o) => o.id).includes(scheduled.id), true);

  const day = (d: string) => Object.values(dayBounds(d, "America/Chicago")).map((x) => x.toISOString());
  check("a Chicago day starts at its own midnight", day("2026-10-03"), ["2026-10-03T05:00:00.000Z", "2026-10-04T05:00:00.000Z"]);
  check("spring-forward day is 23 hours", day("2026-03-08"), ["2026-03-08T06:00:00.000Z", "2026-03-09T05:00:00.000Z"]);
  check("fall-back day is 25 hours", day("2026-11-01"), ["2026-11-01T05:00:00.000Z", "2026-11-02T06:00:00.000Z"]);
  check("11:30 PM in Chicago is still that store date", localDateOf(new Date("2026-10-04T04:30:00Z"), "America/Chicago"), "2026-10-03");

  for (let i = 0; i < 5; i++) await checkPin("0000", operator.id);
  check("five misses lock the device, even for a good PIN", await checkPin("1234", operator.id), { ok: false, reason: "locked_out" });
  await db.delete(pinAttempts).where(eq(pinAttempts.operatorId, operator.id));
  check("a good PIN unlocks once the lock is cleared", (await checkPin("1234", operator.id)).ok, true);
});
