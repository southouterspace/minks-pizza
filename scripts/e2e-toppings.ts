/**
 * Half-and-half toppings e2e against a running dev server and its database:
 * a customer builds a pizza with left, right and whole toppings in the item
 * dialog, the dialog total matches what checkout charges, placement and
 * portion split cart lines and survive a reload, a cart saved before
 * toppings had halves still loads, and the kitchen, order detail and
 * customer order pages show each choice.
 *
 * Run: NODE_PATH=scripts/shims npx tsx --env-file=.env.local scripts/e2e-toppings.ts
 * Mutates orders and adds a temporary operator: point MINKS_DATABASE_URL at
 * a test branch, not production.
 */
import { mkdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import bcrypt from "bcryptjs";
import { chromium, type Page } from "playwright";
import { eq, inArray } from "drizzle-orm";
import { db, itemModifierGroups, modifierGroups, modifiers, operators, orderItems, orders } from "../src/db";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp/e2e-toppings";
const EMAIL = "toppings-e2e@minks.example";
const PASSWORD = "pizza-test-1234";
const CART_KEY = "minks-cart-v1";

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes++;
  else failures++;
}

const cents = (text: string) => Math.round(Number(text.match(/\$([\d,]+\.\d\d)/)![1].replace(",", "")) * 100);

async function openPizza(page: Page) {
  await page.getByText("Cheese Pizza", { exact: true }).first().click();
  await page.waitForSelector('[role="dialog"]');
  await page.click('label:has-text("Large 14")');
}

async function topping(page: Page, name: string, placement?: "Left" | "Right", portion?: "Light" | "Extra") {
  const row = page.locator(`[data-topping="${name}"]`);
  await row.locator("label").click();
  if (placement) await row.getByRole("radio", { name: placement, exact: true }).click();
  if (portion) await row.getByRole("radio", { name: portion, exact: true }).click();
}

const addButton = (page: Page) => page.getByRole("button", { name: /^Add \d+ to cart/ });

async function addToCart(page: Page): Promise<number> {
  const total = cents((await addButton(page).textContent()) ?? "");
  await addButton(page).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  return total;
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  await db.delete(operators).where(eq(operators.email, EMAIL));
  await db
    .insert(operators)
    .values({ email: EMAIL, name: "Toppings Tester", passwordHash: await bcrypt.hash(PASSWORD, 10) });
  await db
    .update(orders)
    .set({ status: "completed" })
    .where(inArray(orders.status, ["new", "confirmed", "preparing", "ready"]));

  const [toppingsGroup] = await db.select().from(modifierGroups).where(eq(modifierGroups.kind, "toppings"));
  const [pepperoni] = await db.select().from(modifiers).where(eq(modifiers.name, "Pepperoni"));
  if (pepperoni.extraPriceDeltaCents === null) {
    await db.update(modifiers).set({ extraPriceDeltaCents: 300 }).where(eq(modifiers.id, pepperoni.id));
  }
  const [cheese] = await db.select().from(modifiers).where(eq(modifiers.name, "Extra Cheese"));
  const [mushrooms] = await db.select().from(modifiers).where(eq(modifiers.name, "Mushrooms"));
  check("seed has a toppings group", toppingsGroup !== undefined, toppingsGroup?.name);

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate((key) => localStorage.removeItem(key), CART_KEY);
  await page.reload({ waitUntil: "networkidle" });

  await openPizza(page);
  const before = cents((await addButton(page).textContent()) ?? "");
  await topping(page, "Pepperoni", "Left", "Extra");
  await topping(page, "Mushrooms", "Right");
  await topping(page, "Extra Cheese");
  const pepRow = page.locator('[data-topping="Pepperoni"]');
  check("extra offered on Pepperoni", await pepRow.getByRole("radio", { name: "Extra", exact: true }).isVisible());
  check(
    "dialog row shows the half-price extra Pepperoni",
    ((await pepRow.locator("label").textContent()) ?? "").includes("+$1.50"),
    (await pepRow.locator("label").textContent()) ?? "",
  );
  await page.locator('[role="dialog"]').screenshot({ path: `${SHOT_DIR}/dialog-desktop.png` });
  const halfPie = await addToCart(page);
  check("dialog total adds 150 + 75 + 200 to the plain Large", halfPie - before === 425, `${before} → ${halfPie}`);

  await openPizza(page);
  await topping(page, "Pepperoni");
  const wholePie = await addToCart(page);

  await page.goto(`${BASE}/cart`, { waitUntil: "networkidle" });
  const cartLines = () => page.locator("main li").filter({ hasText: "Cheese Pizza" });
  check("left-half and whole pepperoni pies are two cart lines", (await cartLines().count()) === 2);
  check(
    "cart shows the choice",
    ((await page.textContent("main")) ?? "").includes("Pepperoni (left half, extra)"),
  );
  await page.screenshot({ path: `${SHOT_DIR}/cart.png`, fullPage: true });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("text=Your cart");
  check("cart persists across a reload", (await cartLines().count()) === 2);

  await page.click("text=Go to checkout");
  await page.waitForSelector("text=Order type");
  await page.fill("#co-name", "Halfie Customer");
  await page.fill("#co-phone", "(555) 010-4455");
  await page.fill("#co-email", "halfie@example.com");
  await page.click('button:has-text("Place pickup order")');
  await page.waitForURL(/\/order\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const orderId = page.url().split("/order/")[1].split(/[?#]/)[0];
  await page.waitForSelector("text=Order received");

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  check(
    "order subtotal equals the dialog totals",
    order.subtotalCents === halfPie + wholePie,
    `${order.subtotalCents} vs ${halfPie} + ${wholePie}`,
  );
  const half = lines.find((l) => l.modifiers.some((m) => m.placement === "left"));
  check("half pie line charged the dialog total", half?.unitPriceCents === halfPie, `${half?.unitPriceCents}`);
  check(
    "half pie snapshot carries ids, placements, portions and charged deltas",
    isDeepStrictEqual(half?.modifiers.filter((m) => m.groupName === toppingsGroup.name), [
        { modifierId: pepperoni.id, groupName: toppingsGroup.name, modifierName: "Pepperoni", priceDeltaCents: 150, placement: "left", portion: "extra" },
        { modifierId: mushrooms.id, groupName: toppingsGroup.name, modifierName: "Mushrooms", priceDeltaCents: 75, placement: "right", portion: "regular" },
        { modifierId: cheese.id, groupName: toppingsGroup.name, modifierName: "Extra Cheese", priceDeltaCents: 200, placement: "whole", portion: "regular" },
    ]),
    JSON.stringify(half?.modifiers),
  );
  check(
    "customer order page shows the choice",
    ((await page.textContent("main")) ?? "").includes("Pepperoni (left half, extra) · Mushrooms (right half) · Extra Cheese"),
  );

  const legacy = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await legacy.goto(BASE, { waitUntil: "networkidle" });
  const pizzaId = half!.menuItemId!;
  const pizzaGroups = (await db.select().from(itemModifierGroups).where(eq(itemModifierGroups.itemId, pizzaId))).map(
    (l) => l.groupId,
  );
  const [large] = await db.select().from(modifiers).where(eq(modifiers.name, 'Large 14"'));
  const defaults = (await db.select().from(modifiers).where(inArray(modifiers.groupId, pizzaGroups))).filter(
    (m) => m.isDefault && m.groupId !== large.groupId,
  );
  const legacyMods = [large, pepperoni, ...defaults].map((m) => ({
    id: m.id,
    groupName: "x",
    modifierName: m.name,
    priceDeltaCents: m.priceDeltaCents,
  }));
  const legacyLine = {
    key: `legacy-key`,
    itemId: pizzaId,
    itemName: "Cheese Pizza",
    unitPriceCents: 1999,
    quantity: 1,
    modifiers: legacyMods,
  };
  await legacy.evaluate(
    ([key, value]) => localStorage.setItem(key, value),
    [CART_KEY, JSON.stringify([legacyLine, { broken: true }])],
  );
  await legacy.goto(`${BASE}/cart`, { waitUntil: "networkidle" });
  await legacy.waitForSelector("text=Your cart");
  const legacyRows = legacy.locator("main li").filter({ hasText: "Cheese Pizza" });
  check("legacy-shaped cart loads", (await legacyRows.count()) === 1);
  const stored = JSON.parse((await legacy.evaluate((k) => localStorage.getItem(k), CART_KEY)) ?? "[]");
  check(
    "legacy line is re-keyed and the unreadable entry dropped",
    stored.length === 1 && stored[0].key === `${pizzaId}:${legacyMods.map((m) => m.id).sort((a, b) => a - b).join(",")}:`,
    JSON.stringify(stored.map((l: { key: string }) => l.key)),
  );
  await legacy.goto(BASE, { waitUntil: "networkidle" });
  await openPizza(legacy);
  await topping(legacy, "Pepperoni");
  await addToCart(legacy);
  await legacy.goto(`${BASE}/cart`, { waitUntil: "networkidle" });
  await legacy.waitForSelector("text=Your cart");
  const merged = JSON.parse((await legacy.evaluate((k) => localStorage.getItem(k), CART_KEY)) ?? "[]");
  check(
    "a new whole-pepperoni pie merges into the legacy line",
    merged.length === 1 && merged[0].quantity === 2,
    JSON.stringify(merged.map((l: { key: string; quantity: number }) => `${l.key}×${l.quantity}`)),
  );
  await legacy.goto(BASE, { waitUntil: "networkidle" });
  await openPizza(legacy);
  await topping(legacy, "Pepperoni", "Left", "Extra");
  await topping(legacy, "Mushrooms", "Right");
  await legacy.locator('[role="dialog"]').screenshot({ path: `${SHOT_DIR}/dialog-375.png` });
  const scrollWidth = await legacy.evaluate(() => document.documentElement.scrollWidth);
  check("dialog fits 375 px with no sideways scroll", scrollWidth <= 375, `${scrollWidth}`);
  await legacy.close();

  const kitchen = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await kitchen.goto(`${BASE}/admin/login`, { waitUntil: "networkidle" });
  await kitchen.fill('input[name="email"]', EMAIL);
  await kitchen.fill('input[name="password"]', PASSWORD);
  await kitchen.click('button[type="submit"]');
  await kitchen.waitForURL(/\/admin$/);
  await kitchen.goto(`${BASE}/kitchen`, { waitUntil: "networkidle" });
  await kitchen.getByTestId("kds-start").click();
  const ticket = kitchen.getByTestId(`kds-ticket-${order.orderNumber}`);
  await ticket.waitFor({ timeout: 10_000 });
  const sections = ticket.getByTestId(`kds-toppings-${half!.id}`);
  const placements = await sections.locator("[data-placement]").evaluateAll((els) =>
    els.map((e) => `${e.getAttribute("data-placement")}=${e.parentElement?.textContent}`),
  );
  check(
    "KDS groups the half pie's toppings as WHOLE / L / R with the portion",
    JSON.stringify(placements) ===
      JSON.stringify(["whole=Whole+ Extra Cheese", "left=LExtra Pepperoni", "right=R+ Mushrooms"]),
    JSON.stringify(placements),
  );
  await ticket.screenshot({ path: `${SHOT_DIR}/kds-ticket.png` });

  await kitchen.goto(`${BASE}/admin/orders/${orderId}`, { waitUntil: "networkidle" });
  check(
    "order detail shows the choice",
    ((await kitchen.textContent("main")) ?? "").includes("Extra Toppings: Pepperoni (left half, extra)"),
  );
  await kitchen.screenshot({ path: `${SHOT_DIR}/order-detail.png`, fullPage: true });
  await kitchen.emulateMedia({ media: "print" });
  check(
    "print ticket shows the choice",
    await kitchen.getByText("Pepperoni (left half, extra)", { exact: true }).isVisible(),
  );
  await kitchen.screenshot({ path: `${SHOT_DIR}/print-ticket.png`, fullPage: true });
  await kitchen.emulateMedia({ media: "screen" });
  await kitchen.setViewportSize({ width: 375, height: 812 });
  await kitchen.screenshot({ path: `${SHOT_DIR}/order-detail-375.png`, fullPage: true });

  await browser.close();

  await db.update(orders).set({ status: "completed" }).where(eq(orders.id, orderId));
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
