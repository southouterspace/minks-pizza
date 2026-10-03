/**
 * Counter POS e2e against a running dev server and its database: PIN unlock,
 * a walk-in half-and-half paid in cash, a returning caller's delivery
 * reordered for later in the store's timezone, collecting on an online order,
 * a dine-in check split three ways, a cashier void after send approved by a
 * manager (and seen as VOID on the KDS), a discount over the threshold, an
 * order rung in while offline and replayed once, and a shift opened and
 * closed with over/short.
 * Asserts what the screen shows and what the database recorded.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-pos.ts
 * Mutates orders, closes any open shift and 86's an item for a moment:
 * point MINKS_DATABASE_URL at a test branch, not production. Expects the
 * seeded menu, demo staff (manager 1234, cashier 5678), 8.25% tax and a
 * $5.00 discount threshold.
 */
import { chromium, type Page } from "playwright";
import { and, eq, gte, isNull, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { adjustments, customers, db, drawerEvents, menuItems, modifierGroups, modifiers, orderItems, orders, pinAttempts, shifts, storeSettings, tenders } from "../src/db";
import type { KdsSnapshot } from "../src/lib/kds";
import { normalizePhone, submitOrder } from "../src/lib/orders-server";
import { formatStoreDateTime, formatStoreTime } from "../src/lib/store-time";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp";
const EMAIL = "kitchen@minks.example";
const PASSWORD = "pizza-test-1234";
const CALLER = { name: "Rita Regular", phone: "(555) 010-7788" };

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function eventually(fn: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return fn();
}

const orderRow = async (id: string) => (await db.select().from(orders).where(eq(orders.id, id)))[0];
const linesOf = (id: string) => db.select().from(orderItems).where(eq(orderItems.orderId, id));
const tendersOf = (id: string) => db.select().from(tenders).where(eq(tenders.orderId, id));

async function signIn(page: Page) {
  await page.goto(`${BASE}/pos`, { waitUntil: "networkidle" });
  if (page.url().includes("/admin/setup")) {
    await page.fill('input[name="name"]', "Kitchen");
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/admin$/);
  } else if (page.url().includes("/admin/login")) {
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/admin$/);
  }
  await page.goto(`${BASE}/pos`, { waitUntil: "networkidle" });
}

const startedAt = new Date();

/** The newest order this run created that matches `where`. */
async function newestOrder(where: SQL) {
  const rows = await db.select().from(orders).where(and(where, gte(orders.placedAt, startedAt)));
  return rows.sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime())[0];
}

async function setup() {
  const [settings] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
  if (settings.taxRateBps !== 825 || settings.discountApprovalCents !== 500) {
    throw new Error("expects the seeded 8.25% tax rate and $5.00 discount threshold");
  }
  await db.update(shifts).set({ closedAt: new Date(), closedBy: 1 }).where(isNull(shifts.closedAt));
  await db.delete(pinAttempts);
  // Clear the board so new orders are easy to find on screen.
  for (const status of ["held", "new", "preparing", "ready"] as const) {
    await db.update(orders).set({ status: "completed" }).where(eq(orders.status, status));
  }

  const items = await db.select().from(menuItems);
  const groups = await db.select().from(modifierGroups);
  const mods = await db.select().from(modifiers);
  const item = (name: string) => items.find((i) => i.name === name)!.id;
  const pick = (group: string, name: string) =>
    mods.find((m) => m.groupId === groups.find((g) => g.name === group)!.id && m.name === name)!.id;
  await db.update(menuItems).set({ isAvailable: true }).where(eq(menuItems.name, "Caesar Salad"));

  // A returning caller: one past delivery order with a pie and a salad.
  await db.delete(customers).where(eq(customers.phone, normalizePhone(CALLER.phone)));
  const past = await submitOrder(
    {
      orderId: randomUUID(),
      channel: "online",
      fulfillment: { kind: "delivery", address: { line1: "42 Oak Lane", line2: "Gate 7", city: "The Woodlands", zip: "77380" } },
      customer: { ...CALLER, email: null, saveAddress: true },
      notes: null,
      fire: { kind: "now" },
      promisedAt: null,
      tipCents: 0,
      lines: [
        {
          lineId: randomUUID(),
          itemId: item("Cheese Pizza"),
          quantity: 1,
          notes: null,
          selections: [
            { modifierId: pick("Size", 'X-Large 16"'), placement: "whole", amount: "regular" },
            { modifierId: pick("Crust", "Thin Crust"), placement: "whole", amount: "regular" },
            { modifierId: pick("Extra Toppings", "Bacon"), placement: "whole", amount: "extra" },
          ],
        },
        { lineId: randomUUID(), itemId: item("Caesar Salad"), quantity: 1, notes: null, selections: [{ modifierId: pick("Dressing", "Caesar"), placement: "whole", amount: "regular" }] },
      ],
      tenders: [],
    },
    { kind: "online" },
  );
  if (!past.ok) throw new Error(`past order rejected: ${JSON.stringify(past)}`);
  await db.update(orders).set({ status: "completed" }).where(eq(orders.id, past.order.id));
  // The salad is 86'd today, so Reorder must flag it.
  await db.update(menuItems).set({ isAvailable: false }).where(eq(menuItems.name, "Caesar Salad"));

  // An online order waiting to be paid at pickup.
  const online = await submitOrder(
    {
      orderId: randomUUID(),
      channel: "online",
      fulfillment: { kind: "pickup" },
      customer: { name: "Olive Online", phone: "(555) 010-4400", email: null, saveAddress: false },
      notes: null,
      fire: { kind: "now" },
      promisedAt: null,
      tipCents: 0,
      lines: [{ lineId: randomUUID(), itemId: item("Margherita"), quantity: 1, notes: null, selections: [{ modifierId: pick("Size", 'Medium 12"'), placement: "whole", amount: "regular" }, { modifierId: pick("Crust", "Hand Tossed"), placement: "whole", amount: "regular" }] }],
      tenders: [],
    },
    { kind: "online" },
  );
  if (!online.ok) throw new Error(`online order rejected: ${JSON.stringify(online)}`);
  return { online: online.order, tz: settings.timezone };
}

async function main() {
  const { online, tz } = await setup();

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
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
  const prints = () => page.evaluate(() => (window as unknown as { __prints: number }).__prints);
  let taps = 0;
  const tap = async (locator: ReturnType<Page["locator"]>) => {
    taps++;
    await locator.click();
  };
  const pin = async (digits: string) => {
    for (const d of digits) await page.locator(`[data-pin-key="${d}"]`).last().click();
  };

  await signIn(page);
  try {
    await flows();
  } catch (e) {
    await shot("failure");
    throw e;
  }
  await browser.close();
  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);

  async function flows() {

  // --- PIN unlock ------------------------------------------------------------
  await page.getByTestId("lock-screen").waitFor();
  await shot("01-lock");
  await pin("9999");
  check("a wrong PIN says so", await page.getByText("That PIN didn't match anyone.").waitFor().then(() => true, () => false));
  await page.keyboard.type("5678");
  await page.getByTestId("order-panel").waitFor();
  check("cashier PIN (typed on the keyboard) unlocks the terminal", await page.getByText("Casey Cashier").isVisible());

  // --- Shift open ------------------------------------------------------------
  await page.getByTestId("open-shift").waitFor();
  await page.getByLabel("Starting bank").fill("150.00");
  await page.getByTestId("open-shift-confirm").click();
  await page.getByTestId("open-shift").waitFor({ state: "detached" });
  const shift = await eventually(async () => (await db.select().from(shifts).where(isNull(shifts.closedAt))).length === 1);
  const [openShift] = await db.select().from(shifts).where(isNull(shifts.closedAt));
  check("shift opens with a $150.00 bank", shift && openShift?.startingBankCents === 15000);

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
  check("builder line reads 2 × Large · L: Pepperoni · R: Mushrooms", summary === '2 × Large 14" · Hand Tossed · L: Pepperoni · R: Mushrooms', summary);
  await shot("03-builder");
  await tap(page.getByTestId("builder-add"));
  const total = await page.getByTestId("draft-total").innerText();
  check("panel total is $40.31 before any network call", total === "$40.31", total);
  await tap(page.getByTestId("pay"));
  await shot("04-tender");
  await tap(page.locator('[data-cash="50"]'));
  await page.getByTestId("change-due").waitFor();
  const change = await page.getByTestId("change-due").innerText();
  check("change due on $50 is $9.69", change === "Change $9.69", change);
  console.log(`      walk-in taps from menu to paid: ${taps}`);
  check("walk-in half-and-half paid in 12 taps or fewer", taps <= 12, `${taps} taps`);
  await shot("05-change");
  await page.getByTestId("tender-done").click();
  const walkIn = await newestOrder(eq(orders.channel, "walk_in"));
  const walkInLines = await linesOf(walkIn.id);
  const walkInTenders = await tendersOf(walkIn.id);
  const placements = walkInLines[0].modifiers.flatMap((m) => (m.kind === "placed" ? [`${m.placement}:${m.modifierName}`] : []));
  check(
    "walk-in stored: 1 line × 2, halves as data, total $40.31, paid",
    walkInLines.length === 1 && walkInLines[0].quantity === 2 && placements.join() === "left:Pepperoni,right:Mushrooms" && walkIn.totalCents === 4031 && walkIn.paidCents === 4031,
    JSON.stringify({ placements, total: walkIn.totalCents, paid: walkIn.paidCents }),
  );
  check("cash tender records $50 handed over", walkInTenders.length === 1 && walkInTenders[0].tenderedCents === 5000 && walkInTenders[0].amountCents === 4031);
  check("walk-in went straight to the kitchen", walkIn.status === "new");

  // --- Phone delivery: lookup → reorder → later --------------------------------
  await page.getByRole("radio", { name: "Delivery" }).click();
  await page.getByTestId("caller-panel").waitFor();
  check("delivery puts the phone field first and focused", await page.getByLabel("Caller phone").evaluate((el) => el === document.activeElement));
  await page.keyboard.type("5550107788");
  await page.getByTestId("recent-order").first().waitFor();
  check("lookup fills the caller's name", (await page.getByLabel("Caller name").inputValue()) === CALLER.name);
  check("lookup fills the saved address", (await page.getByLabel("Street address").inputValue()) === "42 Oak Lane");
  await shot("06-caller");
  await page.getByRole("button", { name: "Reorder" }).first().click();
  const flagged = page.getByText("Not added: tell the caller");
  await flagged.waitFor();
  check("reorder flags the 86'd salad", (await page.getByRole("alert").filter({ hasText: "Caesar Salad" }).count()) === 1);
  const lineSummary = await page.getByTestId("line-summary").first().innerText();
  check("reorder brings back the pie with its options", lineSummary === 'X-Large 16" · Thin Crust · Extra Bacon', lineSummary);
  check("quote time shows while on the phone", /\d+ min/.test(await page.getByTestId("quote").innerText()));
  await shot("06b-reordered");
  await page.getByRole("radio", { name: "Later" }).click();
  await page.getByLabel("Ready at").fill("23:45");
  await shot("07-phone-later");
  await page.getByTestId("send").click();
  const phoneOrder = await eventually(async () => (await newestOrder(eq(orders.customerName, CALLER.name)))?.channel === "phone");
  const delivery = await newestOrder(eq(orders.customerName, CALLER.name));
  check(
    "phone delivery stored held with a fire time, address and fee",
    phoneOrder && delivery.status === "held" && delivery.fireAt !== null && delivery.orderType === "delivery" && delivery.addressLine1 === "42 Oak Lane" && delivery.deliveryFeeCents >= 0,
    JSON.stringify({ status: delivery.status, fireAt: delivery.fireAt, type: delivery.orderType }),
  );
  check(
    "Later 23:45 means 11:45 PM on the store's clock, within the next day",
    delivery.promisedAt !== null && formatStoreTime(delivery.promisedAt, tz) === "11:45 PM" && delivery.promisedAt.getTime() - Date.now() < 86_400_000,
    `${delivery.promisedAt?.toISOString()} in ${tz}`,
  );
  const kds = (await (await context.request.get(`${BASE}/api/kds`)).json()) as KdsSnapshot;
  check("scheduled delivery is not on the KDS", !kds.line.some((o) => o.id === delivery.id));
  await db.update(menuItems).set({ isAvailable: true }).where(eq(menuItems.name, "Caesar Salad"));

  // --- Collect on an online order -----------------------------------------------
  await page.getByTestId("tab-board").click();
  await page.getByTestId("board").waitFor();
  await page.locator(`[data-order="${delivery.orderNumber}"]`).waitFor();
  const heldRow = await page.locator(`[data-order="${delivery.orderNumber}"]`).innerText();
  check("board shows the held delivery in the scheduled lane", heldRow.includes("HELD"));
  check("board shows the fire time in the store's zone", heldRow.includes(`fires ${formatStoreTime(delivery.fireAt!, tz)}`), heldRow.replace(/\n/g, " | "));
  await page.locator(`[data-order="${online.number}"]`).waitFor();
  await shot("08-board");
  await page.getByLabel("Search open orders").fill("Olive");
  check("search by name narrows the board", (await page.locator("[data-order]").count()) === 1);
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
    onlineTender?.method === "card_external" && onlineTender.tipCents === 200 && onlineTender.last4 === "4242" && onlineRow.paidCents === onlineRow.totalCents,
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
  check("dine-in check sent to the kitchen", dine.status === "new" && dine.orderType === "dine_in");
  await page.getByTestId("tab-board").click();
  await page.getByLabel("Search open orders").fill("");
  await page.locator(`[data-order="${dine.orderNumber}"]`).click();
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
    shares.length === 3 && shares.reduce((a, b) => a + b, 0) === dinePaid.totalCents && shares[0] - shares[2] <= 1 && dinePaid.paidCents === dinePaid.totalCents,
    JSON.stringify(shares),
  );

  // --- Cashier void after send → manager PIN → KDS shows VOID ---------------------
  const knots = (await linesOf(dine.id)).find((l) => l.itemName === "Garlic Knots (6)")!;
  await page.getByRole("button", { name: "Void Garlic Knots (6)" }).click();
  await page.getByRole("button", { name: "Customer changed mind" }).click();
  await page.getByTestId("prompt-confirm").click();
  await page.getByTestId("manager-pin").waitFor();
  check("voiding a sent line asks for a manager", true);
  await pin("5678");
  check("a cashier PIN can't approve", await page.getByTestId("manager-pin").getByText("That PIN isn't a manager's.").waitFor().then(() => true, () => false));
  await shot("10-manager-pin");
  await pin("1234");
  await page.getByTestId("manager-pin").waitFor({ state: "detached" });
  const voided = (await db.select().from(orderItems).where(eq(orderItems.id, knots.id)))[0];
  check("void stored with the cashier as actor and the manager as approver", voided.voidedAt !== null && voided.voidedBy === 2 && voided.voidApprovedBy === 1);
  const kitchen = await context.newPage();
  await kitchen.goto(`${BASE}/kitchen`, { waitUntil: "networkidle" });
  const kdsRow = kitchen.getByTestId(`kds-item-${knots.id}`);
  check("KDS shows the voided line as VOID", await eventually(async () => (await kdsRow.getAttribute("data-stage").catch(() => null)) === "void"));
  await kitchen.close();

  // --- Discount: under the threshold, then over it ----------------------------------
  await page.getByTestId("discount").click();
  await page.getByLabel("Amount").fill("2.00");
  await page.getByRole("button", { name: "Coupon" }).click();
  await page.getByTestId("prompt-confirm").click();
  check("a $2 discount needs no manager", await eventually(async () => (await db.select().from(adjustments).where(eq(adjustments.orderId, dine.id))).length === 1));
  await page.getByTestId("discount").click();
  await page.getByLabel("Amount").fill("6.00");
  await page.getByRole("button", { name: "Manager special" }).click();
  await page.getByTestId("prompt-confirm").click();
  await page.getByTestId("manager-pin").waitFor();
  check("a $6 discount pops the manager PIN pad", true);
  await pin("1234");
  await page.getByTestId("manager-pin").waitFor({ state: "detached" });
  const discounts = await db.select().from(adjustments).where(and(eq(adjustments.orderId, dine.id), eq(adjustments.cents, 600)));
  check("$6 discount stored with the manager's approval", discounts.length === 1 && discounts[0].approvedBy === 1);
  await page.getByRole("button", { name: "Log" }).click();
  const log = await page.getByTestId("activity-log").innerText();
  check(
    "activity log shows the store's time",
    log.startsWith(`${formatStoreTime(dine.placedAt, tz)} Placed (`),
    log.split("\n")[0],
  );
  check("activity log names who voided and who approved", /Voided 2 × Garlic Knots.*Casey Cashier · approved by Morgan Manager/.test(log.replace(/\n/g, " ")), log.replace(/\n/g, " | "));
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
  check("failed submit shows NOT SENT in the header", (await page.getByTestId("not-sent-count").innerText()).includes("1 NOT SENT"));
  check("a fallback kitchen ticket was sent to the printer", (await prints()) === printsBefore + 1);
  await page.getByTestId("tab-board").click();
  await page.getByTestId("not-sent").waitFor();
  await shot("12-not-sent");
  const queued = await page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const req = indexedDB.open("minks-pos", 1);
        req.onsuccess = () => {
          const all = req.result.transaction("outbox").objectStore("outbox").getAllKeys();
          all.onsuccess = () => resolve(all.result as string[]);
        };
      }),
  );
  check("the order is saved in IndexedDB", queued.length === 1, JSON.stringify(queued));
  check("nothing reached the database while offline", !(await orderRow(queued[0])));
  await page.unroute("**/api/pos/orders");
  check("replay lands the order once the connection is back", await eventually(async () => !!(await orderRow(queued[0])), 15_000));
  await page.getByTestId("not-sent").waitFor({ state: "detached", timeout: 10_000 });
  check("NOT SENT clears after replay", true);
  await page.waitForTimeout(5_000);
  const replayedLines = await linesOf(queued[0]);
  const replayedTenders = await tendersOf(queued[0]);
  check("one paper ticket for one failed order", (await prints()) === printsBefore + 1);
  check("replayed exactly once: 1 line, 1 tender", replayedLines.length === 1 && replayedTenders.length === 1, `${replayedLines.length} lines, ${replayedTenders.length} tenders`);

  // --- Receipt reprint ------------------------------------------------------------------
  await page.getByLabel("Search open orders").fill(String(dine.orderNumber));
  await page.locator(`[data-order="${dine.orderNumber}"]`).click();
  const beforeReceipt = await prints();
  await page.getByRole("button", { name: "Receipt" }).click();
  await page.waitForTimeout(300);
  check("reprint sends a receipt to the printer", (await prints()) === beforeReceipt + 1);
  const receiptText = await page.locator("#pos-print").innerText();
  check("receipt shows the order and the discount", /Order #\d+[\s\S]*Discounts/.test(receiptText));
  check("receipt prints the store's date and time", receiptText.includes(formatStoreDateTime(dine.placedAt, tz)), receiptText.split("\n").slice(0, 8).join(" | "));

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
  check("a plain line takes a note", (await page.getByTestId("draft-line").innerText()).includes("no ice"));
  await page.getByRole("tab", { name: "Sides & Salads" }).click();
  await page.locator('[data-item="Garlic Knots (6)"]').click();
  await page.getByTestId("send").click();
  await eventually(async () => !!(await newestOrder(eq(orders.tableLabel, "7"))));
  const table7 = await newestOrder(eq(orders.tableLabel, "7"));
  check("Hold keeps the dine-in check off the kitchen", table7.status === "held");
  await page.getByTestId("tab-board").click();
  await page.getByLabel("Search open orders").fill("Table 7");
  await page.locator(`[data-order="${table7.orderNumber}"]`).click();
  await page.getByTestId("fire-all").click();
  check("Fire sends the held lines", await eventually(async () => (await orderRow(table7.id)).status === "new"));
  await page.getByRole("button", { name: "Split by item" }).click();
  await page.getByLabel("Move Sparkling Water").check();
  await page.getByRole("button", { name: /Move 1 to new check/ }).click();
  const childrenOf = async () => (await db.select().from(orders).where(eq(orders.ticketOrderId, table7.id))).filter((o) => o.id !== table7.id);
  const split = await eventually(async () => (await childrenOf()).length === 1);
  const children = await childrenOf();
  const movedLines = children[0] ? await linesOf(children[0].id) : [];
  check("split by item moves the water to a new check on the same ticket", split && movedLines.length === 1 && movedLines[0].itemName === "Sparkling Water");

  // --- Deep link and paid out --------------------------------------------------------------
  await page.goto(`${BASE}/pos?order=${online.id}`, { waitUntil: "networkidle" });
  await page.getByTestId("order-detail").waitFor();
  check("/pos?order= opens that order", (await page.getByTestId("order-detail").innerText()).includes(`#${online.number}`));
  await page.getByTestId("staff-menu").click();
  await page.getByRole("menuitem", { name: "Paid out" }).click();
  await page.getByLabel("Amount").fill("5.00");
  await page.getByRole("button", { name: "Supplies" }).click();
  await page.getByRole("button", { name: "Record" }).click();
  await page.getByTestId("manager-pin").waitFor();
  await pin("1234");
  await page.getByTestId("manager-pin").waitFor({ state: "detached" });
  const paidOut = await eventually(async () => (await db.select().from(drawerEvents).where(and(eq(drawerEvents.shiftId, openShift.id), eq(drawerEvents.kind, "paid_out")))).length === 1);
  check("paid out of the drawer needs and records a manager", paidOut && (await db.select().from(drawerEvents).where(eq(drawerEvents.shiftId, openShift.id)))[0].approvedBy === 1);

  // --- Shift close: counted vs expected ---------------------------------------------------
  await page.getByTestId("staff-menu").click();
  await page.getByTestId("menu-close-shift").click();
  await page.getByTestId("shift-report").waitFor();
  const expectedText = await page.getByTestId("shift-report").innerText();
  const expectedCash = 15000 - 500 + (await db.select().from(tenders).where(and(eq(tenders.shiftId, openShift.id), eq(tenders.method, "cash")))).reduce((s, t) => s + t.amountCents, 0);
  check(`expected cash is bank + cash taken − paid out (${(expectedCash / 100).toFixed(2)})`, expectedText.includes(`$${(expectedCash / 100).toFixed(2)}`), expectedText.split("\n").slice(0, 2).join(" "));
  await page.getByLabel("Counted cash").fill(((expectedCash - 150) / 100).toFixed(2));
  await page.getByLabel("Card batch total").fill("15.00");
  check("short by $1.50 shows before closing", (await page.getByTestId("shift-report").innerText()).includes("-$1.50"));
  await page.getByTestId("close-shift-confirm").click();
  await page.getByTestId("manager-pin").waitFor();
  await pin("1234");
  await page.getByTestId("z-report").waitFor();
  await page.getByTestId("manager-pin").waitFor({ state: "detached" });
  await shot("13-shift-closed");
  const [closedShift] = await db.select().from(shifts).where(eq(shifts.id, openShift.id));
  check("shift closed with counted cash and the manager as closer", closedShift.closedAt !== null && closedShift.countedCashCents === expectedCash - 150 && closedShift.closedBy === 1);
  check("Z report links to the printable page", (await page.getByTestId("z-report").getAttribute("href")) === `/admin/reports/shift/${openShift.id}`);

  // --- Lock ---------------------------------------------------------------------------------
  await page.getByTestId("tender-done").click().catch(() => undefined);
  await page.keyboard.press("Escape");
  await page.getByTestId("lock").click();
  await page.getByTestId("lock-screen").waitFor();
  check("one tap locks the terminal", true);

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
  check("dark screen toggles the dark theme", await page.evaluate(() => document.documentElement.classList.contains("dark")));
  await shot("15-dark");
  await page.getByTestId("staff-menu").click();
  await page.getByRole("menuitemcheckbox", { name: "Dark screen" }).click();
  await page.keyboard.press("Escape");

  // --- Auto-lock after idle -------------------------------------------------------------------
  await db.update(storeSettings).set({ posLockSeconds: 3 }).where(eq(storeSettings.id, 1));
  try {
    await page.reload({ waitUntil: "networkidle" });
    await page.getByTestId("order-panel").waitFor();
    check("the terminal locks itself after the idle time", await page.getByTestId("lock-screen").waitFor({ timeout: 8_000 }).then(() => true, () => false));
  } finally {
    await db.update(storeSettings).set({ posLockSeconds: 120 }).where(eq(storeSettings.id, 1));
  }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
