/**
 * Per-size modifier prices e2e against a running dev server and its
 * database: an operator gives Pepperoni its own Small and Large prices (and
 * a Large extra) in /admin/modifiers, the item dialog quotes Pepperoni at
 * whichever size is picked, Medium keeps the flat price, and checkout
 * charges the dialog total with the sized price in the line snapshot.
 *
 * Run: NODE_PATH=scripts/shims npx tsx --env-file=.env.local scripts/e2e-size-prices.ts
 * Mutates orders and Pepperoni's size prices (removed at the end): point
 * MINKS_DATABASE_URL at a test branch, not production.
 */
import { mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Page } from "playwright";
import { db, modifiers, modifierSizePrices, orderItems, orders } from "../src/db";
import { BASE, SHOT_DIR, check, eventually, launchBrowser, run, signIn } from "./e2e/harness";

const CART_KEY = "minks-cart-v1";
const cents = (text: string) => Math.round(Number(text.match(/\$([\d,]+\.\d\d)/)![1].replace(",", "")) * 100);
const addButton = (page: Page) => page.getByRole("button", { name: /^Add \d+ to cart/ });
const total = async (page: Page) => cents((await addButton(page).textContent()) ?? "");

async function pickSize(page: Page, size: string) {
  await page.locator("label").filter({ hasText: size }).click();
}

run(async () => {
  mkdirSync(SHOT_DIR, { recursive: true });
  const [pepperoni] = await db.select().from(modifiers).where(eq(modifiers.name, "Pepperoni"));
  await db.update(modifiers).set({ priceDeltaCents: 175, extraPriceDeltaCents: null }).where(eq(modifiers.id, pepperoni.id));
  await db.delete(modifierSizePrices).where(eq(modifierSizePrices.modifierId, pepperoni.id));

  const browser = await launchBrowser();
  const admin = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await signIn(admin, { email: "size-prices-e2e@minks.example", password: "pizza-test-1234", name: "Size Tester" }, "/admin/modifiers");
  const row = admin.locator('li:has(> span:text-is("Pepperoni"))');
  await row.locator("summary", { hasText: "Edit" }).click();
  await row.getByLabel('Small 10" price ($)').fill("1.25");
  await row.getByLabel('Large 14" price ($)').fill("2.50");
  await row.getByLabel('Large 14" extra price ($)').fill("4.00");
  await row.getByRole("button", { name: "Save" }).click();
  await eventually(async () => (await db.select().from(modifierSizePrices).where(eq(modifierSizePrices.modifierId, pepperoni.id))).length > 0);
  const rows = await db.select().from(modifierSizePrices).where(eq(modifierSizePrices.modifierId, pepperoni.id));
  check(
    "admin save stores a row per priced size",
    rows.map((r) => [r.priceDeltaCents, r.extraPriceDeltaCents]).sort(),
    [[125, null], [250, 400]],
  );
  await admin.reload({ waitUntil: "networkidle" });
  const summary = (await row.textContent()) ?? "";
  check("modifier row lists the size prices", summary.includes('Small 10" +$1.25') && summary.includes('Large 14" +$2.50 (extra +$4.00)'), true);
  await admin.screenshot({ path: `${SHOT_DIR}/size-prices-admin.png`, fullPage: true });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate((key) => localStorage.removeItem(key), CART_KEY);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Cheese Pizza", { exact: true }).first().click();
  await page.waitForSelector('[role="dialog"]');

  const quoted: Record<string, [string, number]> = {};
  for (const size of ['Small 10"', 'Medium 12"', 'Large 14"']) {
    await pickSize(page, size);
    const plain = await total(page);
    const label = ((await page.locator('[data-topping="Pepperoni"] label').textContent()) ?? "").match(/\+\$\d+\.\d\d/)?.[0] ?? "none";
    await page.locator('[data-topping="Pepperoni"] label').click();
    quoted[size] = [label, (await total(page)) - plain];
    await page.locator('[data-topping="Pepperoni"] label').click();
  }
  check("dialog quotes and charges Pepperoni at each size", quoted, {
    'Small 10"': ["+$1.25", 125],
    'Medium 12"': ["+$1.75", 175],
    'Large 14"': ["+$2.50", 250],
  });

  const plainLarge = await total(page);
  await page.locator('[data-topping="Pepperoni"] label').click();
  await page.locator('[data-topping="Pepperoni"]').getByRole("radio", { name: "Extra", exact: true }).click();
  const largeExtra = await total(page);
  check("extra Pepperoni on a Large costs the Large extra price", largeExtra - plainLarge, 400);
  await page.locator('[role="dialog"]').screenshot({ path: `${SHOT_DIR}/size-prices-dialog.png` });
  await addButton(page).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });

  await page.goto(`${BASE}/cart`, { waitUntil: "networkidle" });
  await page.click("text=Go to checkout");
  await page.waitForSelector("text=Order type");
  await page.fill("#co-name", "Size Customer");
  await page.fill("#co-phone", "(555) 010-7788");
  await page.fill("#co-email", "size@example.com");
  await page.click('button:has-text("Place pickup order")');
  await page.waitForURL(/\/order\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const orderId = page.url().split("/order/")[1].split(/[?#]/)[0];
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  const [line] = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  check("checkout charges the dialog total", [order.subtotalCents, line.unitPriceCents], [largeExtra, largeExtra]);
  check(
    "line snapshot carries the sized extra price",
    line.modifiers.find((m) => m.modifierId === pepperoni.id)?.priceDeltaCents,
    400,
  );

  await browser.close();
  await db.delete(modifierSizePrices).where(eq(modifierSizePrices.modifierId, pepperoni.id));
});
