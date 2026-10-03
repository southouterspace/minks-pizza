/**
 * Kitchen display e2e against a running dev server and its database:
 * orders placed through the real checkout path → make line → oven → kitchen
 * → ready shelf → handoff, plus recall, undo, cancel alerts, live arrival
 * and bump-bar keys. Asserts both what the screen shows and what the
 * database recorded (the customer tracker reads the same status).
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-kds.ts
 * Mutates orders — point MINKS_DATABASE_URL at a test branch, not production.
 */
import { chromium, type Page } from "playwright";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, employees, menuItems, modifierGroups, modifiers, operators, orderItems, orders, storeSettings } from "../src/db";
import { submitOrder } from "../src/lib/orders-server/submit";
import { mutateOrder } from "../src/lib/orders-server/mutate";
import type { Fulfillment } from "../src/lib/orders";
import { formatStoreTime } from "../src/lib/store-time";

/** Places an online order through the same seam the storefront uses. */
async function createOrder(o: {
  customerName: string;
  customerPhone: string;
  fulfillment: Fulfillment;
  notes?: string;
  lines: { itemId: number; quantity: number; modifierIds: number[]; notes?: string }[];
}) {
  const result = await submitOrder(
    {
      orderId: randomUUID(),
      channel: "online",
      fulfillment: o.fulfillment,
      customer: { name: o.customerName, phone: o.customerPhone, email: null, saveAddress: false },
      notes: o.notes ?? null,
      fire: { kind: "now" },
      promisedAt: null,
      tipCents: 0,
      lines: o.lines.map((l) => ({
        lineId: randomUUID(),
        itemId: l.itemId,
        quantity: l.quantity,
        notes: l.notes ?? null,
        selections: l.modifierIds.map((modifierId) => ({ modifierId, placement: "whole" as const, amount: "regular" as const })),
      })),
      tenders: [],
    },
    { kind: "online" },
  );
  if (!result.ok) throw new Error(`order rejected: ${JSON.stringify(result)}`);
  return { id: result.order.id, orderNumber: result.order.number };
}

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp";
const EMAIL = "kitchen@minks.example";
const PASSWORD = "pizza-test-1234";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** The screen updates optimistically; give the server write a moment to land. */
async function eventually(fn: () => Promise<boolean>, ms = 6_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fn();
}

const statusIs = (id: string, status: string) =>
  eventually(async () => (await orderRow(id)).status === status);

async function orderRow(id: string) {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  return o;
}

async function placeOrders() {
  const items = await db.select().from(menuItems);
  const groups = await db.select().from(modifierGroups);
  const mods = await db.select().from(modifiers);
  const item = (name: string) => items.find((i) => i.name === name)!.id;
  const pick = (group: string, name: string) =>
    mods.find((m) => m.groupId === groups.find((g) => g.name === group)!.id && m.name === name)!.id;

  const base = { customerPhone: "(555) 010-2222" } as const;
  const a = await createOrder({
    ...base,
    fulfillment: { kind: "pickup" },
    customerName: "Alice Pickup",
    lines: [
      {
        itemId: item("Cheese Pizza"),
        quantity: 2,
        modifierIds: [pick("Size", 'Large 14"'), pick("Crust", "Thin Crust"), pick("Extra Toppings", "Pepperoni")],
        notes: "well done",
      },
      { itemId: item("Garlic Knots (6)"), quantity: 1, modifierIds: [] },
      { itemId: item("Soda (2-Liter)"), quantity: 1, modifierIds: [] },
    ],
  });
  const b = await createOrder({
    ...base,
    fulfillment: {
      kind: "delivery",
      address: { line1: "1 Main St", line2: null, city: "The Woodlands", zip: "77354" },
    },
    customerName: "Bob Delivery",
    notes: "Peanut allergy",
    lines: [
      {
        itemId: item("Margherita"),
        quantity: 1,
        modifierIds: [pick("Size", 'Medium 12"'), pick("Crust", "Hand Tossed")],
      },
    ],
  });
  return { a, b, item, pick };
}

async function signIn(page: Page) {
  await page.goto(`${BASE}/kitchen`, { waitUntil: "networkidle" });
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
  await page.goto(`${BASE}/kitchen`, { waitUntil: "networkidle" });
}

async function main() {
  // Clear the line so ticket positions are predictable.
  await db.update(orders).set({ status: "completed" }).where(eq(orders.status, "new"));
  await db.update(orders).set({ status: "completed" }).where(eq(orders.status, "preparing"));
  await db.update(orders).set({ status: "completed" }).where(eq(orders.status, "ready"));

  const { a, b, item, pick } = await placeOrders();
  const aItems = await db.select().from(orderItems).where(eq(orderItems.orderId, a.id));
  const stations = Object.fromEntries(aItems.map((i) => [i.itemName, i.station]));
  check(
    "checkout snapshots each line's kitchen station",
    stations["Cheese Pizza"] === "pizza" &&
      stations["Garlic Knots (6)"] === "kitchen" &&
      stations["Soda (2-Liter)"] === "counter",
    JSON.stringify(stations),
  );
  const pizza = aItems.find((i) => i.itemName === "Cheese Pizza")!;

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  });
  // Neither the server's zone (UTC) nor the store's, so a wrong zone shows.
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, timezoneId: "Asia/Tokyo" });
  const shot = (name: string) => page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
  const tab = (name: string) => page.getByRole("button", { name: new RegExp(`^${name}\\s*\\d+$`) });
  const ticketA = page.getByTestId(`kds-ticket-${a.orderNumber}`);
  const ticketB = page.getByTestId(`kds-ticket-${b.orderNumber}`);

  await signIn(page);
  await page.getByTestId("kds-start").click();
  await tab("All").click();

  // --- All view: both tickets, pizza-first layout --------------------------
  await ticketA.waitFor();
  check("ticket A on the All screen", await ticketA.isVisible());
  const [{ timezone: tz }] = await db.select({ timezone: storeSettings.timezone }).from(storeSettings).where(eq(storeSettings.id, 1));
  const clock = await page.getByTestId("kds-clock").innerText();
  check(
    "KDS clock reads the store's time",
    [Date.now(), Date.now() - 60_000].some((t) => formatStoreTime(new Date(t), tz) === clock.trim()),
    `${clock} vs ${formatStoreTime(new Date(), tz)} in ${tz}`,
  );
  check("ticket B on the All screen", await ticketB.isVisible());
  const aText = await ticketA.innerText();
  check(
    "ticket shows size, crust, topping, item note and counter row",
    /LARGE 14"/i.test(aText) &&
      /THIN CRUST/i.test(aText) &&
      aText.includes("+ Pepperoni") &&
      aText.includes("well done") &&
      /Counter:\s*1× Soda/i.test(aText),
    aText.replace(/\s+/g, " "),
  );
  check("order note shown on ticket B", (await ticketB.innerText()).includes("Peanut allergy"));
  check("delivery badge on ticket B", /DELIVERY/i.test(await ticketB.innerText()));
  const allDay = await page.getByTestId("kds-all-day").innerText();
  check("all-day counts the two large cheese pies", /2\s*Cheese Pizza\s*Large 14"/.test(allDay), allDay.replace(/\s+/g, " "));
  await shot("kds-1-all");

  // --- Make line: fire the pies -------------------------------------------
  await tab("Make line").click();
  check("make line shows only pizza items", !(await ticketA.innerText()).includes("Garlic Knots"));
  await page.getByTestId(`kds-item-${pizza.id}`).click();
  await ticketA.waitFor({ state: "detached", timeout: 5_000 });
  check("fired ticket leaves the make line", true);
  await eventually(async () => (await db.select().from(orderItems).where(eq(orderItems.id, pizza.id)))[0].ovenAt !== null);
  const fired = (await db.select().from(orderItems).where(eq(orderItems.id, pizza.id)))[0];
  check("pie has an oven time in the database", fired.ovenAt !== null && fired.doneAt === null);
  check("order moved to preparing (customer tracker)", await statusIs(a.id, "preparing"));

  // --- Oven: countdown, then out ------------------------------------------
  await tab("Oven").click();
  await ticketA.waitFor();
  check("oven screen shows a bake countdown", /OVEN \d+:\d\d/i.test(await ticketA.innerText()));
  await shot("kds-2-oven");
  await page.getByTestId(`kds-bump-${a.orderNumber}`).click();
  await ticketA.waitFor({ state: "detached", timeout: 5_000 });
  check("order waits on the kitchen after the pies are out", (await orderRow(a.id)).status === "preparing");

  // --- Kitchen: knots done → ready (soda never blocks) ---------------------
  await tab("Kitchen").click();
  await ticketA.waitFor();
  await page.getByTestId(`kds-bump-${a.orderNumber}`).click();
  await ticketA.waitFor({ state: "detached", timeout: 5_000 });
  check("kitchen bump makes the order ready", await statusIs(a.id, "ready"));
  check("ready time recorded", (await orderRow(a.id)).readyAt !== null);

  // --- Ready shelf → handoff ----------------------------------------------
  await tab("Ready").click();
  const readyCard = page.getByTestId(`kds-ready-${a.orderNumber}`);
  await readyCard.waitFor();
  await shot("kds-3-ready");
  await page.getByTestId(`kds-handoff-${a.orderNumber}`).click();
  await readyCard.waitFor({ state: "detached", timeout: 5_000 });
  check("handoff completes the order", await statusIs(a.id, "completed"));

  // --- Recall from the panel ----------------------------------------------
  await page.keyboard.press("r");
  await page.getByTestId(`kds-recall-${a.orderNumber}`).click();
  await statusIs(a.id, "preparing");
  const recalled = await orderRow(a.id);
  const recalledItems = await db.select().from(orderItems).where(eq(orderItems.orderId, a.id));
  check(
    "recall puts the order back on the line from scratch",
    recalled.status === "preparing" && recalled.readyAt === null && recalledItems.every((i) => i.ovenAt === null && i.doneAt === null),
  );

  // --- All view: bump + undo; keyboard bump --------------------------------
  await tab("All").click();
  await ticketB.waitFor();
  await page.getByTestId(`kds-bump-${b.orderNumber}`).click();
  await ticketB.waitFor({ state: "detached", timeout: 5_000 });
  check("All-screen bump makes the order ready", await statusIs(b.id, "ready"));
  await page.getByRole("button", { name: "Undo" }).first().click();
  await ticketB.waitFor({ timeout: 5_000 });
  check("Undo brings the bumped ticket back", await statusIs(b.id, "preparing"));

  // Ticket A is first (oldest), B second. "2" selects B, Enter bumps it.
  await page.keyboard.press("2");
  await page.keyboard.press("Enter");
  await ticketB.waitFor({ state: "detached", timeout: 5_000 });
  check("bump-bar keys (2, Enter) bump the second ticket", await statusIs(b.id, "ready"));

  // --- Live arrival + cancel alert ----------------------------------------
  const c = await createOrder({
    fulfillment: { kind: "pickup" },
    customerName: "Carol Late",
    customerPhone: "(555) 010-3333",
    lines: [{ itemId: item("Cheese Pizza"), quantity: 1, modifierIds: [pick("Size", 'Small 10"'), pick("Crust", "Hand Tossed")] }],
  });
  const ticketC = page.getByTestId(`kds-ticket-${c.orderNumber}`);
  await ticketC.waitFor({ timeout: 10_000 });
  check("a new order appears without a reload", true);
  check("new ticket flashes", ((await ticketC.getAttribute("class")) ?? "").includes("kds-fresh"));

  await db.update(orders).set({ status: "canceled", updatedAt: new Date() }).where(eq(orders.id, c.id));
  const alert = page.getByText(`#${c.orderNumber} was canceled`, { exact: false });
  await alert.waitFor({ timeout: 10_000 });
  check("canceling an on-screen order raises an alert", await alert.isVisible());
  await shot("kds-4-cancel-alert");

  // --- Counter orders: halves, held, voids ---------------------------------
  const [operator] = await db.select().from(operators).limit(1);
  const [manager] = await db.select().from(employees).where(eq(employees.role, "manager")).limit(1);
  const staff = {
    operatorId: operator.id,
    actor: { employeeId: manager.id, name: manager.name, role: manager.role },
  };
  const counterLine = (itemId: number, selections: { modifierId: number; placement: "whole" | "left" | "right" }[]) => ({
    lineId: randomUUID(),
    itemId,
    quantity: 1,
    notes: null,
    selections: selections.map((x) => ({ ...x, amount: "regular" as const })),
  });
  const pie = counterLine(item("Cheese Pizza"), [
    { modifierId: pick("Size", 'Large 14"'), placement: "whole" },
    { modifierId: pick("Crust", "Hand Tossed"), placement: "whole" },
    { modifierId: pick("Extra Toppings", "Pepperoni"), placement: "left" },
    { modifierId: pick("Extra Toppings", "Mushrooms"), placement: "right" },
  ]);
  const wings = counterLine(item("Chicken Wings (8)"), [{ modifierId: pick("Sauce", "BBQ"), placement: "whole" }]);
  const counterOrder = (fire: { kind: "now" } | { kind: "at"; at: string }, lines: ReturnType<typeof counterLine>[]) =>
    submitOrder(
      {
        orderId: randomUUID(),
        channel: "phone",
        fulfillment: { kind: "pickup" },
        customer: { name: "Dana Phone", phone: "(555) 010-4444", email: null, saveAddress: false },
        notes: null,
        fire,
        promisedAt: null,
        tipCents: 0,
        lines,
        tenders: [],
      },
      { kind: "pos", staff },
    );
  const d = await counterOrder({ kind: "now" }, [pie, wings]);
  const later = await counterOrder({ kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() }, [
    counterLine(item("Cheese Pizza"), [
      { modifierId: pick("Size", 'Small 10"'), placement: "whole" },
      { modifierId: pick("Crust", "Hand Tossed"), placement: "whole" },
    ]),
  ]);
  if (!d.ok || !later.ok) throw new Error("counter orders rejected");
  const ticketD = page.getByTestId(`kds-ticket-${d.order.number}`);
  await ticketD.waitFor({ timeout: 10_000 });
  const left = await ticketD.getByTestId("kds-half-left").innerText();
  const right = await ticketD.getByTestId("kds-half-right").innerText();
  check("half toppings print in LEFT and RIGHT blocks", /LEFT HALF/i.test(left) && left.includes("+ Pepperoni") && /RIGHT HALF/i.test(right) && right.includes("+ Mushrooms"), `${left} | ${right}`);
  await page.waitForTimeout(5_000);
  check("a scheduled order stays off the line", (await page.getByTestId(`kds-ticket-${later.order.number}`).count()) === 0);
  const wingsId = (await db.select().from(orderItems).where(eq(orderItems.lineUid, wings.lineId)))[0].id;
  const voided = await mutateOrder({ orderId: d.order.id, mutation: { kind: "void_line", lineId: wings.lineId, reason: "changed mind" } }, staff);
  check("manager voids a sent line", voided.ok);
  const wingsRow = page.getByTestId(`kds-item-${wingsId}`);
  check(
    "voided line stays on the ticket, struck and marked VOID",
    await eventually(async () => (await wingsRow.getAttribute("data-stage")) === "void"),
    await wingsRow.innerText(),
  );
  check("VOID label shown", (await wingsRow.innerText()).includes("VOID"));
  await shot("kds-4b-halves-void");

  const knots = counterLine(item("Garlic Knots (6)"), []);
  const table = await submitOrder(
    {
      orderId: randomUUID(),
      channel: "walk_in",
      fulfillment: { kind: "dine_in", table: "12" },
      customer: null,
      notes: null,
      fire: { kind: "now" },
      promisedAt: null,
      tipCents: 0,
      lines: [
        counterLine(item("Margherita"), [
          { modifierId: pick("Size", 'Medium 12"'), placement: "whole" },
          { modifierId: pick("Crust", "Hand Tossed"), placement: "whole" },
        ]),
        knots,
      ],
      tenders: [],
    },
    { kind: "pos", staff },
  );
  if (!table.ok) throw new Error(`dine-in order rejected: ${JSON.stringify(table)}`);
  const childId = randomUUID();
  const split = await mutateOrder({ orderId: table.order.id, mutation: { kind: "split_by_item", lineIds: [knots.lineId], newOrderId: childId } }, staff);
  if (!split.ok) throw new Error(`split rejected: ${JSON.stringify(split)}`);
  const childNumber = (await orderRow(childId)).orderNumber;
  await page.getByTestId(`kds-ticket-${table.order.number}`).waitFor({ timeout: 10_000 });
  check("a split table is one ticket on the line", (await page.getByTestId(`kds-ticket-${childNumber}`).count()) === 0);
  await page.getByTestId(`kds-bump-${table.order.number}`).click();
  check("bumping the split table readies both checks", (await statusIs(table.order.id, "ready")) && (await statusIs(childId, "ready")));
  // A reload renders the server's snapshot, not the optimistic one.
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("kds-start").click();
  await tab("Ready").click();
  await page.getByTestId(`kds-ready-${table.order.number}`).waitFor({ timeout: 10_000 });
  check(
    "a split table is one card on the ready shelf",
    (await page.getByTestId(`kds-ready-${table.order.number}`).count()) === 1 && (await page.getByTestId(`kds-ready-${childNumber}`).count()) === 0,
  );
  await page.getByTestId(`kds-handoff-${table.order.number}`).click();
  check("handing off the card completes both checks", (await statusIs(table.order.id, "completed")) && (await statusIs(childId, "completed")));
  await page.keyboard.press("r");
  await page.getByTestId(`kds-recall-${table.order.number}`).waitFor({ timeout: 10_000 });
  check("the recall list shows the split table once", (await page.getByTestId(`kds-recall-${childNumber}`).count()) === 0);
  await page.keyboard.press("Escape");
  await tab("All").click();

  // --- Offline banner -------------------------------------------------------
  await page.context().setOffline(true);
  const banner = page.getByText("Connection lost", { exact: false });
  await banner.waitFor({ timeout: 25_000 });
  check("offline banner after sync stops", await banner.isVisible());
  check("tickets stay on screen while offline", await ticketA.isVisible());
  await shot("kds-5-offline");
  await page.context().setOffline(false);
  await banner.waitFor({ state: "detached", timeout: 15_000 });
  check("banner clears when the connection returns", true);

  await browser.close();
  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
