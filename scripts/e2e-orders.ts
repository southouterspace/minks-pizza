/**
 * Order management e2e against a running dev server and its database:
 * orders placed through the real checkout path, then the board (advance
 * through every status, +10 min, cancel with a reason, two tablets tapping
 * the same button), history search, filters and CSV export, the detail
 * page timeline, payment and notes, a KDS recall's audit row, and the
 * new-order alert. Asserts both the screen and what the database recorded.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-orders.ts
 * Mutates orders and adds a temporary operator: point MINKS_DATABASE_URL at
 * a test branch, not production.
 */
import { mkdirSync } from "node:fs";
import bcrypt from "bcryptjs";
import { chromium, type Browser, type Page } from "playwright";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, menuItems, modifierGroups, modifiers, operators, orderEvents, orders, storeSettings } from "../src/db";
import { createOrder } from "../src/lib/orders";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp/e2e-orders";
const EMAIL = "orders-e2e@minks.example";
const NAME = "Order Tester";
const PASSWORD = "pizza-test-1234";

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes++;
  else failures++;
}

async function eventually(fn: () => Promise<boolean>, ms = 8_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fn();
}

async function orderRow(id: string) {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  return o;
}

const statusIs = (id: string, status: string) =>
  eventually(async () => (await orderRow(id)).status === status);

async function events(id: string) {
  return db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, id))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));
}

const moves = async (id: string) =>
  (await events(id))
    .filter((e) => e.type === "status_changed")
    .map((e) => `${e.fromStatus}->${e.toStatus}`);

async function menu() {
  const items = await db.select().from(menuItems);
  const groups = await db.select().from(modifierGroups);
  const mods = await db.select().from(modifiers);
  const item = (name: string) => items.find((i) => i.name === name)!.id;
  const pick = (group: string, name: string) =>
    mods.find((m) => m.groupId === groups.find((g) => g.name === group)!.id && m.name === name)!.id;
  const pie = (quantity = 1) => ({
    itemId: item("Cheese Pizza"),
    quantity,
    modifiers: [pick("Size", 'Large 14"'), pick("Crust", "Thin Crust")].map((id) => ({ id })),
  });
  return { item, pie };
}

async function signIn(browser: Browser, width = 1366): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin$/);
  return page;
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  await db.delete(operators).where(eq(operators.email, EMAIL));
  const [operator] = await db
    .insert(operators)
    .values({ email: EMAIL, name: NAME, passwordHash: await bcrypt.hash(PASSWORD, 10) })
    .returning();

  // Clear the board so lane contents are predictable.
  await db
    .update(orders)
    .set({ status: "completed" })
    .where(inArray(orders.status, ["new", "confirmed", "preparing", "ready"]));

  const { item, pie } = await menu();
  const [settings] = await db.select().from(storeSettings);
  const a = await createOrder({
    orderType: "pickup",
    customerName: "Ozzie Board",
    customerPhone: "(555) 246-8135",
    customerEmail: "ozzie@example.com",
    tipCents: 300,
    lines: [pie(2), { itemId: item("Garlic Knots (6)"), quantity: 1, modifiers: [], notes: "extra butter" }],
  });
  const b = await createOrder({
    orderType: "delivery",
    customerName: "Bella Cancel, Jr.",
    customerPhone: "555.777.0101",
    addressLine1: "1 Main St",
    city: "The Woodlands",
    zip: "77354",
    tipCents: 0,
    lines: [pie(2)],
  });

  // --- Checkout --------------------------------------------------------------
  check(
    "checkout quotes promisedAt = placedAt + pickup prep minutes",
    a.promisedAt!.getTime() - a.placedAt.getTime() === settings.pickupPrepMinutes * 60_000,
    `${a.placedAt.toISOString()} → ${a.promisedAt?.toISOString()}`,
  );
  check(
    "checkout uses delivery prep minutes for delivery",
    b.promisedAt!.getTime() - b.placedAt.getTime() === settings.deliveryPrepMinutes * 60_000,
  );
  const placed = (await events(a.id))[0];
  check(
    "checkout writes a placed event by Customer",
    placed?.type === "placed" && placed.actor === "Customer" && placed.toStatus === "new",
  );

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  });
  const page = await signIn(browser);
  const card = (n: number) => page.getByTestId(`board-order-${n}`);
  const lane = (title: string) => page.getByTestId(`lane-${title}`);

  // --- Board: advance through every status -----------------------------------
  await card(a.orderNumber).waitFor();
  check("new order sits in the New lane", await lane("New").getByTestId(`board-order-${a.orderNumber}`).isVisible());
  check("KPI strip renders", (await page.getByTestId("kpi-strip").innerText()).includes("Net sales"));
  await page.screenshot({ path: `${SHOT_DIR}/board-desktop.png`, fullPage: true });

  const steps = [
    { label: "Confirm", to: "confirmed", lane: "In kitchen" },
    { label: "Start preparing", to: "preparing", lane: "In kitchen" },
    { label: "Mark ready", to: "ready", lane: "Ready" },
  ] as const;
  for (const step of steps) {
    const button = page.getByTestId(`advance-${a.orderNumber}`).filter({ hasText: step.label });
    check(
      `button reads "${step.label}"`,
      await button.waitFor({ timeout: 8_000 }).then(() => true).catch(() => false),
    );
    await button.click();
    check(`board moves the order to ${step.to}`, await statusIs(a.id, step.to));
    await lane(step.lane).getByTestId(`board-order-${a.orderNumber}`).waitFor({ timeout: 8_000 });
    check(`card shows in the ${step.lane} lane`, true);
  }
  check("ready stamps readyAt", (await orderRow(a.id)).readyAt !== null);
  await page.getByTestId(`advance-${a.orderNumber}`).click();
  check("Complete finishes the order", await statusIs(a.id, "completed"));
  check("completedAt stamped", (await orderRow(a.id)).completedAt !== null);
  await card(a.orderNumber).waitFor({ state: "detached", timeout: 8_000 });
  check("completed order leaves the board", true);
  const aMoves = await moves(a.id);
  check(
    "one status event per move, in order",
    JSON.stringify(aMoves) === JSON.stringify(["new->confirmed", "confirmed->preparing", "preparing->ready", "ready->completed"]),
    JSON.stringify(aMoves),
  );
  const aEvents = await events(a.id);
  check(
    "board events carry the operator",
    aEvents.filter((e) => e.type === "status_changed").every((e) => e.actor === NAME && e.operatorId === operator.id),
  );

  // --- +10 min ------------------------------------------------------------------
  const before = (await orderRow(b.id)).promisedAt!;
  await page.getByTestId(`eta10-${b.orderNumber}`).click();
  check(
    "+10 pushes promisedAt by exactly ten minutes",
    await eventually(async () => (await orderRow(b.id)).promisedAt!.getTime() - before.getTime() === 600_000),
  );
  const eta = (await events(b.id)).find((e) => e.type === "eta_changed");
  check("+10 logs an eta_changed event", eta?.note === "+10 min" && eta.actor === NAME);

  // --- Cancel with a reason ----------------------------------------------------
  await page.getByTestId(`cancel-${b.orderNumber}`).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.screenshot({ path: `${SHOT_DIR}/board-cancel-dialog.png` });
  await dialog.locator("select[name=reason]").selectOption("Kitchen too busy");
  await dialog.locator("input[name=detail]").fill("Oven down");
  await dialog.getByRole("button", { name: "Cancel order", exact: true }).click();
  check("cancel sets status canceled", await statusIs(b.id, "canceled"));
  const bRow = await orderRow(b.id);
  check("cancelReason saved", bRow.cancelReason === "Kitchen too busy: Oven down", String(bRow.cancelReason));
  check("canceledAt stamped", bRow.canceledAt !== null);
  const cancelEvent = (await events(b.id)).find((e) => e.toStatus === "canceled");
  check(
    "cancel logs an event with the reason",
    cancelEvent?.fromStatus === "new" && cancelEvent.note === "Kitchen too busy: Oven down",
  );
  await dialog.waitFor({ state: "detached", timeout: 5_000 });
  check("dialog closes after canceling", true);

  const tracker = await browser.newPage();
  await tracker.goto(`${BASE}/order/${b.id}`);
  check(
    "customer tracker shows the cancel reason",
    (await tracker.getByTestId("cancel-reason").innerText()).includes("Kitchen too busy"),
  );

  // --- New-order alert -----------------------------------------------------------
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  const baseTitle = await page.title();
  check("no alert on first load", !/New order/.test(baseTitle), baseTitle);
  const c = await createOrder({
    orderType: "pickup",
    customerName: "Cora Chime",
    customerPhone: "(555) 300-1234",
    tipCents: 0,
    lines: [pie()],
  });
  await tracker.goto(`${BASE}/order/${c.id}`);
  check("tracker shows the quoted ready time", /Ready around \d{1,2}:\d\d [AP]M/.test(await tracker.getByTestId("ready-around").innerText()));
  const flashed = await page
    .waitForFunction(() => /^\(1\) New order$/.test(document.title), null, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false);
  check("an arriving order flashes the tab title", flashed, await page.title());
  await card(c.orderNumber).waitFor();
  await page.screenshot({ path: `${SHOT_DIR}/board-alert.png`, fullPage: true });
  const toggle = page.getByTestId("chime-toggle");
  await toggle.click();
  check("mute toggle turns the chime off", (await toggle.getAttribute("aria-pressed")) === "false");
  check(
    "mute choice is saved per device",
    (await page.evaluate(() => localStorage.getItem("minks:admin-chime-muted"))) === "1",
  );
  check(
    "a tap acknowledges the alert",
    await page
      .waitForFunction(() => !/New order/.test(document.title), null, { timeout: 5_000 })
      .then(() => true)
      .catch(() => false),
  );
  await toggle.click();

  // --- Two tablets tap Confirm on the same order --------------------------------
  const tablet2 = await signIn(browser);
  await tablet2.getByTestId(`advance-${c.orderNumber}`).waitFor();
  await page.getByTestId(`advance-${c.orderNumber}`).click();
  await statusIs(c.id, "confirmed");
  await tablet2.getByTestId(`advance-${c.orderNumber}`).click();
  const toast = tablet2.getByText("Order is already confirmed.");
  check(
    "the second tablet's stale tap is refused with a toast",
    await toast.waitFor({ timeout: 8_000 }).then(() => true).catch(() => false),
  );
  check("and applied once", JSON.stringify(await moves(c.id)) === JSON.stringify(["new->confirmed"]));
  await tablet2.close();

  // --- History: search, filters, export -----------------------------------------
  await page.goto(`${BASE}/admin/orders`, { waitUntil: "networkidle" });
  await page.fill('input[name="q"]', "Ozzie");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForURL(/q=Ozzie/);
  check("history search by name finds the order", await page.getByTestId(`history-row-${a.orderNumber}`).isVisible());
  check("…and only matching orders", !(await page.getByTestId(`history-row-${b.orderNumber}`).isVisible()));
  await page.screenshot({ path: `${SHOT_DIR}/history-desktop.png`, fullPage: true });

  await page.goto(`${BASE}/admin/orders?q=${encodeURIComponent("246-8135")}`);
  check("search by phone digits ignores formatting", await page.getByTestId(`history-row-${a.orderNumber}`).isVisible());
  await page.goto(`${BASE}/admin/orders?q=5557770101`);
  check("bare digits match a dotted phone", await page.getByTestId(`history-row-${b.orderNumber}`).isVisible());
  await page.goto(`${BASE}/admin/orders?q=${a.orderNumber}`);
  check("search by order number", await page.getByTestId(`history-row-${a.orderNumber}`).isVisible());

  await page.goto(`${BASE}/admin/orders?status=canceled`);
  check("status filter keeps canceled orders", await page.getByTestId(`history-row-${b.orderNumber}`).isVisible());
  check("status filter drops completed ones", !(await page.getByTestId(`history-row-${a.orderNumber}`).isVisible()));
  check(
    "filter state survives in the form",
    (await page.locator('select[name="status"]').inputValue()) === "canceled",
  );

  const csv = await page.request.get(`${BASE}/api/admin/orders/export?q=${encodeURIComponent("Bella")}`);
  const csvText = await csv.text();
  check("CSV export responds as text/csv", csv.status() === 200 && (csv.headers()["content-type"] ?? "").startsWith("text/csv"));
  check(
    "CSV row present with comma-safe quoting",
    csvText.split("\r\n").some((l) => l.startsWith(`${b.orderNumber},`) && l.includes('"Bella Cancel, Jr."')),
    csvText.split("\r\n").slice(0, 2).join(" | "),
  );
  check("CSV has the cancel reason column", csvText.includes("Kitchen too busy: Oven down"));
  const anon = await (await browser.newContext()).request.get(`${BASE}/api/admin/orders/export`);
  check("CSV export requires a signed-in operator", anon.status() === 401);

  // --- Detail: payment, note, timeline -------------------------------------------
  await page.goto(`${BASE}/admin/orders/${a.id}`, { waitUntil: "networkidle" });
  await page.getByTestId("pay-card").click();
  check(
    "record payment flips paymentStatus",
    await eventually(async () => {
      const o = await orderRow(a.id);
      return o.paymentStatus === "paid" && o.paymentMethod === "card";
    }),
  );
  await page.getByTestId("pay-card").waitFor({ state: "detached", timeout: 8_000 });
  check("payment buttons disappear once paid", true);
  await page.fill("#order-note", "Customer called: running late");
  await page.getByTestId("add-note").click();
  check(
    "note logs a note_added event",
    await eventually(async () => (await events(a.id)).some((e) => e.type === "note_added" && e.note === "Customer called: running late")),
  );

  // KDS recall goes through the same endpoint the display uses.
  const recall = await page.request.post(`${BASE}/api/kds`, { data: { type: "recall", orderId: a.id } });
  check("KDS recall request accepted", recall.ok());
  check("recall puts the order back to preparing", await statusIs(a.id, "preparing"));
  const recallEvent = (await events(a.id)).find((e) => e.fromStatus === "completed" && e.toStatus === "preparing");
  check("KDS recall writes an event", recallEvent?.actor === `Kitchen display · ${NAME}`, recallEvent?.actor);
  const recalled = await orderRow(a.id);
  check("recall clears readyAt and completedAt", recalled.readyAt === null && recalled.completedAt === null);

  await page.reload({ waitUntil: "networkidle" });
  const timeline = await page.getByTestId("timeline").innerText();
  const expected = [
    "Order placed",
    "Confirmed",
    "Preparing",
    "Ready",
    "Completed",
    "Payment recorded · Card",
    "Note · Customer called: running late",
    "Recalled to the kitchen",
  ];
  let cursor = -1;
  const inOrder = expected.every((text) => {
    const at = timeline.indexOf(text, cursor + 1);
    cursor = at;
    return at >= 0;
  });
  check("timeline lists every event oldest first", inOrder, timeline.replace(/\s+/g, " "));
  check("timeline names the actors", timeline.includes(NAME) && timeline.includes("Customer") && timeline.includes("Kitchen display"));
  await page.screenshot({ path: `${SHOT_DIR}/detail-desktop.png`, fullPage: true });
  await page.emulateMedia({ media: "print" });
  await page.screenshot({ path: `${SHOT_DIR}/detail-print.png`, fullPage: true });
  await page.emulateMedia({ media: "screen" });

  // --- Phone width -----------------------------------------------------------------
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: `${SHOT_DIR}/detail-375.png`, fullPage: true });
  await page.goto(`${BASE}/admin/orders`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOT_DIR}/history-375.png`, fullPage: true });
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  const lanes = await Promise.all(
    ["New", "In kitchen", "Ready"].map(async (t) => (await lane(t).boundingBox())!),
  );
  check("lanes stack on a phone", lanes[0].y < lanes[1].y && lanes[1].y < lanes[2].y && lanes[0].x === lanes[1].x);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check("board has no horizontal scroll at 375px", !overflow);
  await page.screenshot({ path: `${SHOT_DIR}/board-375.png`, fullPage: true });

  await browser.close();

  // Leave the board as found: test orders off it, test operator gone.
  await db
    .update(orders)
    .set({ status: "completed" })
    .where(and(inArray(orders.id, [a.id, c.id]), inArray(orders.status, ["new", "confirmed", "preparing", "ready"])));
  await db.delete(operators).where(eq(operators.email, EMAIL));
  const [gone] = await db.select().from(operators).where(eq(operators.email, EMAIL));
  check("test operator cleaned up", gone === undefined);

  console.log(failures === 0 ? `\nALL PASSED (${passes})` : `\n${failures} FAILED, ${passes} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await db.delete(operators).where(eq(operators.email, EMAIL)).catch(() => {});
  process.exit(1);
});
