import { randomUUID } from "node:crypto";
/**
 * Counter POS e2e against a running dev server and its database: PIN unlock,
 * a walk-in half-and-half paid in cash, a returning caller's delivery
 * reordered for later in the store's timezone, collecting on an online order,
 * a dine-in check split three ways and one pizza shared by three guests, a
 * cashier void after send approved by a manager (and seen as VOID on the
 * KDS), a discount over the threshold, an order rung in while offline and
 * replayed once, and a shift opened and closed with over/short.
 * Asserts what the screen shows and what the database recorded.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-pos.ts
 * Mutates orders, closes any open shift and 86's an item for a moment:
 * point MINKS_DATABASE_URL at a test branch, not production. Expects the
 * seeded menu, demo staff (manager 1234, cashier 5678), 8.25% tax and a
 * $5.00 discount threshold.
 */
import type { Locator, Page } from "playwright";
import { and, eq, gte, isNull, type SQL } from "drizzle-orm";
import { orderDiscounts, customers, db, drawerEvents, employees, menuItems, operators, orderItems, orders, pinAttempts, drawerSessions, storeSettings, tenders } from "../src/db";
import type { KdsSnapshot } from "../src/lib/kds";
import { normalizePhone } from "../src/lib/orders";
import { createOrder } from "../src/lib/checkout";
import { mutateOrder } from "../src/lib/orders-server/mutate";
import { BASE, check, eventually, launchBrowser, menuLookup, run, SHOT_DIR, signIn } from "./e2e/harness";

const KITCHEN = { name: "Kitchen", email: "kitchen@minks.example", password: "pizza-test-1234" };
const CALLER = { name: "Rita Regular", phone: "(555) 010-7788" };

/** True once `locator` is on screen, false if it never shows. */
const shows = (locator: Locator, timeout = 5_000) => locator.waitFor({ timeout }).then(() => true, () => false);
const gone = (locator: Locator, timeout = 10_000) => locator.waitFor({ state: "detached", timeout }).then(() => true, () => false);

/** Waits out an enter animation: the box reads the same twice in a row. */
async function settled(locator: Locator) {
  let last = "";
  await eventually(async () => {
    const box = JSON.stringify(await locator.boundingBox());
    const still = box === last;
    last = box;
    return still;
  }, 3_000);
}

const orderRow = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0];
const linesOf = (id: string) => db.select().from(orderItems).where(eq(orderItems.orderId, id));
const tendersOf = (id: string) => db.select().from(tenders).where(eq(tenders.orderId, id));

const startedAt = new Date();

/** The newest order this run created that matches `where`. */
async function newestOrder(where: SQL, since = startedAt) {
  const rows = await db.select().from(orders).where(and(where, gte(orders.placedAt, since)));
  return rows.sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime())[0];
}

async function setup() {
  const [settings] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
  if (settings.taxRateBps !== 825 || settings.discountApprovalCents !== 500) {
    throw new Error("expects the seeded 8.25% tax rate and $5.00 discount threshold");
  }
  const staff = await db.select({ id: employees.id, name: employees.name }).from(employees);
  const staffId = (name: string) => {
    const e = staff.find((x) => x.name === name);
    if (!e) throw new Error(`expects the demo employee ${name}`);
    return e.id;
  };
  const manager = staffId("Morgan Manager");
  const cashier = staffId("Casey Cashier");
  await db.update(drawerSessions).set({ closedAt: new Date(), closedBy: manager }).where(isNull(drawerSessions.closedAt));
  await db.delete(pinAttempts);
  // Clear the board so new orders are easy to find on screen.
  for (const status of ["held", "new", "preparing", "ready"] as const) {
    await db.update(orders).set({ status: "completed" }).where(eq(orders.status, status));
  }

  const { item, pick } = await menuLookup();
  await db.update(menuItems).set({ isAvailable: true }).where(eq(menuItems.name, "Caesar Salad"));

  // A returning caller: one past delivery order with a pie and a salad.
  await db.delete(customers).where(eq(customers.phone, normalizePhone(CALLER.phone)));
  const whole = (modifierId: number, amount: "regular" | "extra" = "regular") => ({ modifierId, placement: "whole" as const, amount });
  const past = await createOrder({
    orderType: "delivery",
    customerName: CALLER.name,
    customerPhone: CALLER.phone,
    addressLine1: "42 Oak Lane",
    addressLine2: "Gate 7",
    city: "The Woodlands",
    zip: "77380",
    tipCents: 0,
    lines: [
      {
        itemId: item("Cheese Pizza"),
        quantity: 1,
        notes: null,
        selections: [whole(pick("Size", 'X-Large 16"')), whole(pick("Crust", "Thin Crust")), whole(pick("Extra Toppings", "Bacon"), "extra")],
      },
      { itemId: item("Caesar Salad"), quantity: 1, notes: null, selections: [whole(pick("Dressing", "Caesar"))] },
    ],
  });
  await db.update(orders).set({ status: "completed" }).where(eq(orders.id, past.id));
  // The salad is 86'd today, so Reorder must flag it.
  await db.update(menuItems).set({ isAvailable: false }).where(eq(menuItems.name, "Caesar Salad"));

  // An online order waiting to be paid at pickup.
  const online = await createOrder({
    orderType: "pickup",
    customerName: "Olive Online",
    customerPhone: "(555) 010-4400",
    tipCents: 0,
    lines: [{ itemId: item("Margherita"), quantity: 1, notes: null, selections: [whole(pick("Size", 'Medium 12"')), whole(pick("Crust", "Hand Tossed"))] }],
  });
  const [operator] = await db.select({ id: operators.id }).from(operators).where(eq(operators.email, KITCHEN.email));
  return { online, tz: settings.timezone, manager, cashier, operatorId: operator?.id ?? 0 };
}

async function main() {
  const { online, tz, manager, cashier, operatorId } = await setup();
  // The expected wall clocks come from Intl in the store's zone, not from the app's formatters.
  const storeClock = (at: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...options }).format(at);
  const clock12 = (minutes: number) => `${((Math.floor(minutes / 60) + 11) % 12) + 1}:${String(minutes % 60).padStart(2, "0")} ${minutes >= 720 ? "PM" : "AM"}`;

  const browser = await launchBrowser();
  // A browser zone that is neither the server's (UTC) nor the store's, so a
  // time formatted in the wrong zone can't pass by accident.
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, timezoneId: "Asia/Tokyo" });
  // Count print dialogs instead of opening them.
  await context.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      (window as unknown as { __prints: number }).__prints += 1;
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  page.on("console", (m) => m.type() === "error" && console.log("console:", m.text().slice(0, 300)));
  // Let dialog and toast animations settle so the picture is what a person sees.
  const shot = async (name: string) => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOT_DIR}/pos-${name}.png` });
  };
  const outboxKeys = () =>
    page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const req = indexedDB.open("minks-pos", 1);
          req.onsuccess = () => {
            const all = req.result.transaction("outbox").objectStore("outbox").getAllKeys();
            all.onsuccess = () => resolve(all.result as string[]);
          };
        }),
    );
  const prints = () => page.evaluate(() => (window as unknown as { __prints: number }).__prints);
  let taps = 0;
  const tap = async (locator: ReturnType<Page["locator"]>) => {
    taps++;
    await locator.click();
  };
  const pin = async (digits: string) => {
    for (const d of digits) await page.locator(`[data-pin-key="${d}"]`).last().click();
  };

  await signIn(page, KITCHEN, "/pos");
  try {
    await flows();
  } catch (e) {
    await shot("failure");
    throw e;
  }
  await browser.close();

  async function flows() {

  // --- PIN unlock ------------------------------------------------------------
  await page.getByTestId("lock-screen").waitFor();
  await shot("01-lock");
  await pin("9999");
  check("a wrong PIN says so", await page.getByText("That PIN didn't match anyone.").waitFor().then(() => true, () => false), true);
  await page.keyboard.type("5678");
  await page.getByTestId("order-panel").waitFor();
  check("cashier PIN (typed on the keyboard) unlocks the terminal", await page.getByText("Casey Cashier").isVisible(), true);

  // --- Shift open ------------------------------------------------------------
  await page.getByTestId("open-shift").waitFor();
  await page.getByLabel("Starting bank").fill("150.00");
  await page.getByTestId("open-shift-confirm").click();
  await page.getByTestId("open-shift").waitFor({ state: "detached" });
  const shift = await eventually(async () => (await db.select().from(drawerSessions).where(isNull(drawerSessions.closedAt))).length === 1);
  const [openShift] = await db.select().from(drawerSessions).where(isNull(drawerSessions.closedAt));
  check("shift opens with a $150.00 bank", [shift, openShift?.startingBankCents], [true, 15000]);

  // --- Walk-in: 2 × half-and-half large, cash ---------------------------------
  await shot("02-menu");
  taps = 0;
  await tap(page.getByRole("tab", { name: "Build Your Own" }));
  await tap(page.locator('[data-item="Cheese Pizza"]'));
  await tap(page.getByRole("button", { name: /Large 14"/ }));
  await tap(page.getByRole("radio", { name: "Left ½" }));
  await tap(page.locator('[data-topping="Pepperoni"]'));
  await tap(page.getByRole("radio", { name: "Right ½" }));
  await tap(page.locator('[data-topping="Mushrooms"]'));
  await tap(page.getByRole("button", { name: "One more" }));
  const summary = await page.getByTestId("builder-summary").innerText();
  check("builder line reads 2 × Large · L: Pepperoni · R: Mushrooms", summary, '2 × Large 14" · Hand Tossed · L: Pepperoni · R: Mushrooms');
  await shot("03-builder");
  await tap(page.getByTestId("builder-add"));
  const total = await page.getByTestId("draft-total").innerText();
  check("panel total is $40.31 before any network call", total, "$40.31");
  await tap(page.getByTestId("pay"));
  await shot("04-tender");
  await tap(page.locator('[data-cash="50"]'));
  await page.getByTestId("change-due").waitFor();
  const change = await page.getByTestId("change-due").innerText();
  check("change due on $50 is $9.69", change, "Change $9.69");
  console.log(`      walk-in taps from menu to paid: ${taps}`);
  check("walk-in half-and-half paid in 12 taps or fewer", taps <= 12, true);
  await shot("05-change");
  await page.getByTestId("tender-done").click();
  const walkIn = await newestOrder(eq(orders.source, "walk_in"));
  const walkInLines = await linesOf(walkIn.id);
  const walkInTenders = await tendersOf(walkIn.id);
  const placements = walkInLines[0].modifiers.flatMap((m) => (m.kind === "placed" ? [`${m.placement}:${m.modifierName}`] : []));
  check(
    "walk-in stored: 1 line × 2, halves as data, total $40.31, paid",
    { lines: walkInLines.length, quantity: walkInLines[0].quantity, placements: placements.join(), total: walkIn.totalCents, paid: walkIn.paidCents },
    { lines: 1, quantity: 2, placements: "left:Pepperoni,right:Mushrooms", total: 4031, paid: 4031 },
  );
  check("cash tender records $50 handed over", walkInTenders.map((t) => [t.tenderedCents, t.amountCents]), [[5000, 4031]]);
  check("walk-in went straight to the kitchen", walkIn.status, "new");

  // --- Phone delivery: lookup → reorder → later --------------------------------
  await page.getByRole("radio", { name: "Delivery" }).click();
  await page.getByTestId("caller-panel").waitFor();
  check("delivery puts the phone field first and focused", await page.getByLabel("Caller phone").evaluate((el) => el === document.activeElement), true);
  await page.keyboard.type("5550107788");
  await page.getByTestId("recent-order").first().waitFor();
  check("lookup fills the caller's name", await page.getByLabel("Caller name").inputValue(), "Rita Regular");
  check("lookup fills the saved address", await page.getByLabel("Street address").inputValue(), "42 Oak Lane");
  await shot("06-caller");
  await page.getByRole("button", { name: "Reorder" }).first().click();
  const flagged = page.getByText("Not added: tell the caller");
  await flagged.waitFor();
  check("reorder flags the 86'd salad", await page.getByRole("alert").filter({ hasText: "Caesar Salad" }).count(), 1);
  const lineSummary = await page.getByTestId("line-summary").first().innerText();
  check("reorder brings back the pie with its options", lineSummary, 'X-Large 16" · Thin Crust · Extra Bacon');
  check("quote time shows while on the phone", /\d+ min/.test(await page.getByTestId("quote").innerText()), true);
  await shot("06b-reordered");
  await page.getByRole("radio", { name: "Later" }).click();
  await page.getByLabel("Ready at").fill("23:45");
  await shot("07-phone-later");
  await page.getByTestId("send").click();
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "sent (held)" });
  await toast.waitFor();
  await settled(toast);
  const boxes = await Promise.all([toast, page.locator("header"), page.getByTestId("send"), page.getByTestId("pay")].map((l) => l.boundingBox()));
  const [toastBox, ...covered] = boxes;
  const overlaps = (a: NonNullable<typeof toastBox>, b: NonNullable<typeof toastBox>) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  check("the sent toast covers neither the header nor Send and Pay", covered.map((b) => !toastBox || !b || overlaps(toastBox, b)), [false, false, false]);
  check("the toast sits above two wrapped rows of order-detail actions", !!toastBox && toastBox.y + toastBox.height <= 768 - 2 * 48 - 8 - 12, true);
  await shot("07b-sent-toast");
  const phoneOrder = await eventually(async () => (await newestOrder(eq(orders.customerName, CALLER.name)))?.source === "phone");
  const delivery = await newestOrder(eq(orders.customerName, CALLER.name));
  check(
    "phone delivery stored held with a fire time, address and fee",
    { phone: phoneOrder, status: delivery.status, fires: delivery.fireAt !== null, type: delivery.orderType, address: delivery.addressLine1, fee: delivery.deliveryFeeCents >= 0 },
    { phone: true, status: "held", fires: true, type: "delivery", address: "42 Oak Lane", fee: true },
  );
  check(
    "Later 23:45 means 23:45 on the store's clock, within the next day",
    delivery.promisedAt && [storeClock(delivery.promisedAt, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), delivery.promisedAt.getTime() - Date.now() < 86_400_000],
    ["23:45", true],
  );
  const kds = (await (await context.request.get(`${BASE}/api/kds`)).json()) as KdsSnapshot;
  check("scheduled delivery is not on the KDS", kds.line.some((o) => o.id === delivery.id), false);
  await db.update(menuItems).set({ isAvailable: true }).where(eq(menuItems.name, "Caesar Salad"));

  // --- Collect on an online order -----------------------------------------------
  await page.getByTestId("tab-board").click();
  await page.getByTestId("board").waitFor();
  await page.locator(`[data-order="${delivery.orderNumber}"]`).waitFor();
  const heldRow = await page.locator(`[data-order="${delivery.orderNumber}"]`).innerText();
  check("board shows the held delivery in the scheduled lane", heldRow.includes("HELD"), true);
  const quoteMinutes = delivery.promisedAt && delivery.fireAt ? (delivery.promisedAt.getTime() - delivery.fireAt.getTime()) / 60_000 : NaN;
  check("board shows the fire time, 23:45 less the quote, in the store's zone", heldRow.includes(`fires ${clock12(23 * 60 + 45 - quoteMinutes)}`), true);
  await page.locator(`[data-order="${online.number}"]`).waitFor();
  await shot("08-board");
  await page.getByLabel("Search open orders").fill("Olive");
  check("search by name narrows the board", await page.locator("[data-order]").count(), 1);
  await page.locator(`[data-order="${online.number}"]`).click();
  await page.getByTestId("order-detail").waitFor();
  await page.getByTestId("order-pay").click();
  await page.getByRole("radio", { name: "Card (terminal)" }).click();
  await page.getByLabel("Card tip").fill("2.00");
  await page.getByLabel("Card last 4").fill("4242");
  await page.getByTestId("card-record").click();
  await page.getByTestId("paid").waitFor();
  await page.getByTestId("tender-done").click();
  const [onlineTender] = await tendersOf(online.id);
  const onlineRow = await orderRow(online.id);
  check(
    "online order collected by card with tip and last 4",
    { method: onlineTender?.method, tip: onlineTender?.tipCents, last4: onlineTender?.last4, paidInFull: onlineRow.paidCents === onlineRow.totalCents },
    { method: "card_external", tip: 200, last4: "4242", paidInFull: true },
  );

  // --- Dine-in: send, then split three ways --------------------------------------
  await page.getByRole("button", { name: "New order" }).click();
  await page.getByRole("radio", { name: "Dine-in" }).click();
  await page.getByLabel("Table").fill("4");
  await page.getByRole("tab", { name: "Sides & Salads" }).click();
  await page.locator('[data-item="Garlic Knots (6)"]').click();
  await page.locator('[data-item="Garlic Knots (6)"]').click();
  await page.getByRole("tab", { name: "Specialty Pizzas" }).click();
  await page.locator('[data-item="Pepperoni Classic"]').click();
  await page.getByTestId("builder-add").click();
  await page.getByTestId("send").click();
  await eventually(async () => (await newestOrder(eq(orders.tableLabel, "4")))?.status === "new");
  const dine = await newestOrder(eq(orders.tableLabel, "4"));
  check("dine-in check sent to the kitchen", [dine.status, dine.orderType], ["new", "dine_in"]);
  await page.getByTestId("tab-board").click();
  await page.getByLabel("Search open orders").fill("");
  await page.locator(`[data-order="${dine.orderNumber}"]`).click();
  // --- Discount: under the threshold, then over it ----------------------------------
  await page.getByTestId("discount").click();
  await page.getByLabel("Amount").fill("2.00");
  await page.getByRole("button", { name: "Coupon" }).click();
  await page.getByTestId("prompt-confirm").click();
  check("a $2 discount needs no manager", await eventually(async () => (await db.select().from(orderDiscounts).where(eq(orderDiscounts.orderId, dine.id))).length === 1), true);
  await page.getByTestId("discount").click();
  await page.getByLabel("Amount").fill("6.00");
  await page.getByRole("button", { name: "Manager special" }).click();
  await page.getByTestId("prompt-confirm").click();
  check("a $6 discount pops the manager PIN pad", await shows(page.getByTestId("manager-pin").getByText("Discount $6.00")), true);
  await pin("1234");
  await page.getByTestId("manager-pin").waitFor({ state: "detached" });
  const discounts = await db.select().from(orderDiscounts).where(and(eq(orderDiscounts.orderId, dine.id), eq(orderDiscounts.amountCents, 600)));
  check("$6 discount stored with the manager's approval", discounts.map((d) => d.approvedBy), [manager]);

  // --- Pay: split three ways; money on the check then locks discounts -----------
  await page.getByTestId("order-pay").click();
  await page.getByRole("button", { name: "Split 3 ways" }).click();
  await shot("09-split");
  for (let i = 0; i < 3; i++) {
    await page.getByTestId("cash-exact").click();
    if (i < 2) await page.getByText(`Guest ${i + 2} of 3`).waitFor();
  }
  await page.getByTestId("paid").waitFor();
  await page.getByTestId("tender-done").click();
  const dineTenders = await tendersOf(dine.id);
  const dinePaid = await orderRow(dine.id);
  const shares = dineTenders.map((t) => t.amountCents).sort((a, b) => b - a);
  check(
    "dine-in split into 3 cash tenders that sum to the total",
    { tenders: shares.length, sumIsTotal: shares.reduce((a, b) => a + b, 0) === dinePaid.totalCents, withinACent: shares[0] - shares[2] <= 1, paidInFull: dinePaid.paidCents === dinePaid.totalCents },
    { tenders: 3, sumIsTotal: true, withinACent: true, paidInFull: true },
  );

  const lockedDiscount = await mutateOrder(
    { orderId: dine.id, mutation: { kind: "discount", id: randomUUID(), lineId: null, cents: 100, reason: "too late" } },
    { actor: { employeeId: manager, name: "Morgan Manager", access: "manager" }, operatorId: operatorId },
  );
  check("once paid, a discount is refused: money goes back as a refund", lockedDiscount.ok === false && lockedDiscount.reason === "rejected", true);

  // --- Cashier void after send → manager PIN → KDS shows VOID ---------------------
  const knots = (await linesOf(dine.id)).find((l) => l.itemName === "Garlic Knots (6)")!;
  await page.getByRole("button", { name: "Void Garlic Knots (6)" }).click();
  await page.getByRole("button", { name: "Customer changed mind" }).click();
  check("the void prompt says a sent line needs a manager", (await page.getByTestId("prompt-dialog").innerText()).includes("Already sent to the kitchen: a manager must approve."), true);
  await page.getByTestId("prompt-confirm").click();
  check("voiding a sent line asks for a manager", await shows(page.getByTestId("manager-pin").getByText("Void Garlic Knots (6)")), true);
  await pin("5678");
  check("a cashier PIN can't approve", await page.getByTestId("manager-pin").getByText("That PIN isn't a manager's.").waitFor().then(() => true, () => false), true);
  await shot("10-manager-pin");
  await pin("1234");
  await page.getByTestId("manager-pin").waitFor({ state: "detached" });
  const voided = (await db.select().from(orderItems).where(eq(orderItems.id, knots.id)))[0];
  check("void stored with the cashier as actor and the manager as approver", [voided.voidedAt !== null, voided.voidedBy, voided.voidApprovedBy], [true, cashier, manager]);
  const kitchen = await context.newPage();
  await kitchen.goto(`${BASE}/kitchen`, { waitUntil: "networkidle" });
  const kdsRow = kitchen.getByTestId(`kds-item-${knots.id}`);
  check("KDS shows the voided line as VOID", await eventually(async () => (await kdsRow.getAttribute("data-stage").catch(() => null)) === "void"), true);
  await kitchen.close();

  await page.getByRole("button", { name: "Log" }).click();
  const log = await page.getByTestId("activity-log").innerText();
  check(
    "activity log reads placed as dine-in, at the store's time",
    log.startsWith(`${storeClock(dine.placedAt, { hour: "numeric", minute: "2-digit" })} Placed (Dine-in, table 4)`),
    true,
  );
  check("activity log names who voided and who approved", /Voided 2 × Garlic Knots.*Casey Cashier · approved by Morgan Manager/.test(log.replace(/\n/g, " ")), true);
  await shot("11-order-detail");

  // --- Offline submit → NOT SENT → replayed once ---------------------------------------
  await page.getByRole("button", { name: "New order" }).click();
  await page.getByRole("radio", { name: "Walk-in" }).click();
  await page.route("**/api/pos/orders", (route) => route.abort("internetdisconnected"));
  const printsBefore = await prints();
  await page.getByRole("tab", { name: "Drinks" }).click();
  await page.locator('[data-item="Soda (2-Liter)"]').click();
  await page.getByTestId("pay").click();
  await page.getByTestId("cash-exact").click();
  await page.getByTestId("paid").waitFor();
  await page.getByTestId("tender-done").click();
  await page.getByTestId("not-sent-count").waitFor();
  check("failed submit shows NOT SENT in the header", (await page.getByTestId("not-sent-count").innerText()).includes("1 NOT SENT"), true);
  check("a fallback kitchen ticket was sent to the printer", await prints(), printsBefore + 1);
  await page.getByTestId("tab-board").click();
  await page.getByTestId("not-sent").waitFor();
  await shot("12-not-sent");
  const queued = await outboxKeys();
  check("the order is saved in IndexedDB", queued.length, 1);
  check("nothing reached the database while offline", !!(await orderRow(queued[0])), false);
  await page.unroute("**/api/pos/orders");
  check("replay lands the order once the connection is back", await eventually(async () => !!(await orderRow(queued[0])), 15_000), true);
  check("NOT SENT clears after replay", await gone(page.getByTestId("not-sent")), true);
  check("the replayed order leaves the device's queue, so nothing can send it again", await eventually(async () => (await outboxKeys()).length === 0), true);
  const replayedLines = await linesOf(queued[0]);
  const replayedTenders = await tendersOf(queued[0]);
  check("one paper ticket for one failed order", await prints(), printsBefore + 1);
  check("replayed exactly once: 1 line, 1 tender", [replayedLines.length, replayedTenders.length], [1, 1]);

  // --- Receipt reprint ------------------------------------------------------------------
  await page.getByLabel("Search open orders").fill(String(dine.orderNumber));
  await page.locator(`[data-order="${dine.orderNumber}"]`).click();
  const beforeReceipt = await prints();
  await page.getByRole("button", { name: "Receipt" }).click();
  check("reprint sends a receipt to the printer", await eventually(async () => (await prints()) === beforeReceipt + 1, 3_000), true);
  const receiptText = await page.locator("#pos-print").innerText();
  check("receipt shows the order and the discount", /Order #\d+[\s\S]*Discounts/.test(receiptText), true);
  check("receipt prints the store's date and time", receiptText.includes(storeClock(dine.placedAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })), true);

  // --- Dine-in hold → fire → split by item; a note on a plain line ------------------------
  await page.getByRole("button", { name: "New order" }).click();
  await page.getByRole("radio", { name: "Dine-in" }).click();
  await page.getByLabel("Table").fill("7");
  await page.getByRole("radio", { name: "Hold" }).click();
  await page.getByRole("tab", { name: "Drinks" }).click();
  await page.locator('[data-item="Sparkling Water"]').click();
  await page.getByTestId("draft-line").filter({ hasText: "Sparkling Water" }).getByRole("button", { name: /^Sparkling Water \$/ }).click();
  await page.getByPlaceholder("well done, cut in squares…").fill("no ice");
  await page.getByTestId("builder-add").click();
  check("a plain line takes a note", (await page.getByTestId("draft-line").innerText()).includes("no ice"), true);
  await page.getByRole("tab", { name: "Sides & Salads" }).click();
  await page.locator('[data-item="Garlic Knots (6)"]').click();
  await page.getByTestId("send").click();
  await eventually(async () => !!(await newestOrder(eq(orders.tableLabel, "7"))));
  const table7 = await newestOrder(eq(orders.tableLabel, "7"));
  check("Hold keeps the dine-in check off the kitchen", table7.status, "held");
  await page.getByTestId("tab-board").click();
  await page.getByLabel("Search open orders").fill("Table 7");
  await page.locator(`[data-order="${table7.orderNumber}"]`).click();
  await page.getByTestId("fire-all").click();
  check("Fire sends the held lines", await eventually(async () => (await orderRow(table7.id)).status === "new"), true);
  await page.getByRole("button", { name: "Split by item" }).click();
  await page.getByLabel("Move Sparkling Water").check();
  await page.getByRole("button", { name: /Move 1 to new check/ }).click();
  const childrenOf = async () => (await db.select().from(orders).where(eq(orders.ticketOrderId, table7.id))).filter((o) => o.id !== table7.id);
  const split = await eventually(async () => (await childrenOf()).length === 1);
  const children = await childrenOf();
  const movedLines = children[0] ? await linesOf(children[0].id) : [];
  check("split by item moves the water to a new check on the same ticket", [split, movedLines.map((l) => l.itemName)], [true, ["Sparkling Water"]]);

  // --- One pizza shared by three guests, each paying their own share -----------------------
  await page.getByRole("button", { name: "New order" }).click();
  await page.getByRole("radio", { name: "Dine-in" }).click();
  await page.getByLabel("Table").fill("9");
  await page.getByRole("tab", { name: "Specialty Pizzas" }).click();
  await page.locator('[data-item="Pepperoni Classic"]').click();
  await page.getByTestId("builder-add").click();
  await page.getByRole("tab", { name: "Drinks" }).click();
  await page.locator('[data-item="Soda (2-Liter)"]').click();
  await page.locator('[data-item="Sparkling Water"]').click();
  await page.getByTestId("send").click();
  await eventually(async () => (await newestOrder(eq(orders.tableLabel, "9")))?.status === "new");
  const table9 = await newestOrder(eq(orders.tableLabel, "9"));
  await page.getByTestId("tab-board").click();
  await page.getByLabel("Search open orders").fill("Table 9");
  await page.locator(`[data-order="${table9.orderNumber}"]`).click();
  await page.getByTestId("order-pay").click();
  await page.getByRole("button", { name: "Split 3 ways" }).click();
  await page.getByRole("button", { name: "Guest 1 had 1 × Soda (2-Liter)" }).click();
  await page.getByRole("button", { name: "Guest 2 had 1 × Sparkling Water" }).click();
  const shownShares = (await page.getByTestId("split-shares").innerText()).match(/\$\d+\.\d\d/g) ?? [];
  await shot("09b-split-by-item");
  for (let i = 0; i < 3; i++) {
    await page.getByTestId("cash-exact").click();
    if (i < 2) await page.getByText(`Guest ${i + 2} of 3`).waitFor();
  }
  await page.getByTestId("paid").waitFor();
  await page.getByTestId("tender-done").click();
  const t9 = (await tendersOf(table9.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((t) => t.amountCents);
  const t9Row = await orderRow(table9.id);
  const taxed = (cents: number) => Math.round(cents * 1.0825);
  check(
    "pizza shared three ways: each guest pays a third of it plus their own drink, to the cent",
    {
      tenders: t9.length,
      sumIsTotal: t9.reduce((a, b) => a + b, 0) === t9Row.totalCents,
      paidInFull: t9Row.paidCents === t9Row.totalCents,
      sodaOnGuest1: Math.abs(t9[0] - t9[2] - taxed(399)) <= 2,
      waterOnGuest2: Math.abs(t9[1] - t9[2] - taxed(249)) <= 2,
      shownIsCharged: shownShares.join() === t9.map((c) => `$${(c / 100).toFixed(2)}`).join(),
    },
    { tenders: 3, sumIsTotal: true, paidInFull: true, sodaOnGuest1: true, waterOnGuest2: true, shownIsCharged: true },
  );

  // --- Deep link and paid out --------------------------------------------------------------
  await page.goto(`${BASE}/pos?order=${online.id}`, { waitUntil: "networkidle" });
  await page.getByTestId("order-detail").waitFor();
  check("/pos?order= opens that order", (await page.getByTestId("order-detail").innerText()).includes(`#${online.number}`), true);
  await page.getByTestId("staff-menu").click();
  await page.getByRole("menuitem", { name: "Paid out" }).click();
  await page.getByLabel("Amount").fill("5.00");
  await page.getByRole("button", { name: "Supplies" }).click();
  await page.getByRole("button", { name: "Record" }).click();
  await page.getByTestId("manager-pin").waitFor();
  await pin("1234");
  await page.getByTestId("manager-pin").waitFor({ state: "detached" });
  const paidOut = await eventually(async () => (await db.select().from(drawerEvents).where(and(eq(drawerEvents.drawerSessionId, openShift.id), eq(drawerEvents.kind, "paid_out")))).length === 1);
  check("paid out of the drawer needs and records a manager", [paidOut, (await db.select().from(drawerEvents).where(eq(drawerEvents.drawerSessionId, openShift.id)))[0]?.approvedBy], [true, manager]);

  // --- Shift close: counted vs expected ---------------------------------------------------
  await page.getByTestId("staff-menu").click();
  await page.getByTestId("menu-close-shift").click();
  await page.getByTestId("shift-report").waitFor();
  const expectedText = await page.getByTestId("shift-report").innerText();
  check(
    "expected cash: $150 bank + the cash tenders ($40.31, three $7.57/$7.56 shares, $4.32, $10.46, $8.82, $6.13) − $5 paid out = $237.74",
    expectedText.startsWith("Expected cash\n$237.74"),
    true,
  );
  await page.getByLabel("Counted cash").fill("236.24");
  await page.getByLabel("Card batch total").fill("15.00");
  check("short by $1.50 shows before closing", (await page.getByTestId("shift-report").innerText()).includes("-$1.50"), true);
  await page.getByTestId("close-shift-confirm").click();
  await page.getByTestId("manager-pin").waitFor();
  await pin("1234");
  await page.getByTestId("z-report").waitFor();
  await page.getByTestId("manager-pin").waitFor({ state: "detached" });
  await shot("13-shift-closed");
  const [closedShift] = await db.select().from(drawerSessions).where(eq(drawerSessions.id, openShift.id));
  check("shift closed with counted cash and the manager as closer", [closedShift.closedAt !== null, closedShift.countedCashCents, closedShift.closedBy], [true, 23624, manager]);
  check("Z report links to the printable page", await page.getByTestId("z-report").getAttribute("href"), `/admin/reports/shift/${openShift.id}`);

  // --- Lock ---------------------------------------------------------------------------------
  await page.getByTestId("tender-done").click().catch(() => undefined);
  await page.keyboard.press("Escape");
  await page.getByTestId("lock").click();
  check("one tap locks the terminal", await shows(page.getByTestId("lock-screen")), true);

  // --- 1366 × 768 layout -----------------------------------------------------------------------
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.keyboard.type("1234");
  await page.getByTestId("order-panel").waitFor();
  await page.keyboard.press("Escape");
  await shot("14-wide");
  await page.getByTestId("staff-menu").click();
  await page.getByRole("menuitemcheckbox", { name: "Dark screen" }).click();
  await page.keyboard.press("Escape");
  await page.getByTestId("tab-board").click();
  check("dark screen toggles the dark theme", await page.evaluate(() => document.documentElement.classList.contains("dark")), true);
  await shot("15-dark");
  await page.getByTestId("staff-menu").click();
  await page.getByRole("menuitemcheckbox", { name: "Dark screen" }).click();
  await page.keyboard.press("Escape");

  // --- Idle lock in the middle of a split payment keeps the money that was taken --------------
  await page.clock.install();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("staff-menu").click();
  await page.getByRole("menuitem", { name: "Open shift…" }).click();
  await page.getByLabel("Starting bank").fill("100.00");
  await page.getByTestId("open-shift-confirm").click();
  await page.getByTestId("open-shift").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "New order" }).click();
  await page.getByRole("radio", { name: "Walk-in" }).click();
  await page.getByRole("tab", { name: "Sides & Salads" }).click();
  await page.locator('[data-item="Garlic Knots (6)"]').click();
  const payPressedAt = new Date();
  await page.getByTestId("pay").click();
  await page.getByRole("button", { name: "Split 3 ways" }).click();
  check("guest 1 of 3 owes $2.16 of the $6.48 knots", await page.getByTestId("tender-due").innerText(), "$2.16");
  await page.getByTestId("cash-exact").click();
  await page.getByText("Guest 2 of 3").waitFor();
  await page.clock.fastForward(130_000);
  check("the idle timer locks the terminal mid-split", await page.getByTestId("lock-screen").waitFor({ timeout: 5_000 }).then(() => true, () => false), true);
  const splitOrder = await eventually(async () => (await newestOrder(eq(orders.source, "walk_in"), payPressedAt)) !== undefined);
  const knotsOrder = await newestOrder(eq(orders.source, "walk_in"), payPressedAt);
  const takenBeforeLock = knotsOrder ? (await tendersOf(knotsOrder.id)).map((t) => t.amountCents) : [];
  check("guest 1's $2.16 is on a recorded $6.48 order after the lock", [splitOrder, knotsOrder?.totalCents, takenBeforeLock.join()], [true, 648, "216"]);
  await page.keyboard.type("5678");
  await page.getByTestId("order-panel").waitFor();
  check("unlocking starts a clean new order", await page.getByTestId("draft-total").innerText(), "$0.00");
  if (knotsOrder) {
    await page.getByTestId("tab-board").click();
    await page.getByLabel("Search open orders").fill(`#${knotsOrder.orderNumber}`);
    await page.locator(`[data-order="${knotsOrder.orderNumber}"]`).click();
    await page.getByTestId("order-pay").click();
    check("the open order still owes the other $4.32", await page.getByTestId("tender-due").innerText(), "$4.32");
    await page.getByTestId("cash-exact").click();
    await page.getByTestId("paid").waitFor();
    await page.getByTestId("tender-done").click();
    const settled = await orderRow(knotsOrder.id);
    const allTenders = (await tendersOf(knotsOrder.id)).map((t) => t.amountCents).sort((a, b) => a - b);
    check("the rest is collected after unlock: $2.16 + $4.32 = $6.48 paid", [settled.paidCents, allTenders.join()], [648, "216,432"]);
  }

  // --- Auto-lock after idle -------------------------------------------------------------------
  await db.update(storeSettings).set({ posLockSeconds: 3 }).where(eq(storeSettings.id, 1));
  try {
    await page.reload({ waitUntil: "networkidle" });
    await page.getByTestId("order-panel").waitFor();
    check("the terminal locks itself after the idle time", await page.getByTestId("lock-screen").waitFor({ timeout: 8_000 }).then(() => true, () => false), true);
  } finally {
    await db.update(storeSettings).set({ posLockSeconds: 120 }).where(eq(storeSettings.id, 1));
  }
  }
}

run(main);
