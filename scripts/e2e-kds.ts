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
import { db, menuItems, modifierGroups, modifiers, orderItems, orders } from "../src/db";
import { createOrder } from "../src/lib/orders";

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

  const base = { customerPhone: "(555) 010-2222", tipCents: 0 } as const;
  const a = await createOrder({
    ...base,
    orderType: "pickup",
    customerName: "Alice Pickup",
    lines: [
      {
        itemId: item("Cheese Pizza"),
        quantity: 2,
        modifiers: [pick("Size", 'Large 14"'), pick("Crust", "Thin Crust"), pick("Extra Toppings", "Pepperoni")].map((id) => ({ id })),
        notes: "well done",
      },
      { itemId: item("Garlic Knots (6)"), quantity: 1, modifiers: [] },
      { itemId: item("Soda (2-Liter)"), quantity: 1, modifiers: [] },
    ],
  });
  const b = await createOrder({
    ...base,
    orderType: "delivery",
    customerName: "Bob Delivery",
    addressLine1: "1 Main St",
    city: "The Woodlands",
    zip: "77354",
    orderNotes: "Peanut allergy",
    lines: [
      {
        itemId: item("Margherita"),
        quantity: 1,
        modifiers: [pick("Size", 'Medium 12"'), pick("Crust", "Hand Tossed")].map((id) => ({ id })),
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
  await db.update(orders).set({ status: "completed" }).where(eq(orders.status, "confirmed"));
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
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
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
    orderType: "pickup",
    customerName: "Carol Late",
    customerPhone: "(555) 010-3333",
    tipCents: 0,
    lines: [{ itemId: item("Cheese Pizza"), quantity: 1, modifiers: [pick("Size", 'Small 10"'), pick("Crust", "Hand Tossed")].map((id) => ({ id })) }],
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
