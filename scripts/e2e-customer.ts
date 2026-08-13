/**
 * Customer-flow smoke test against a running dev server (http://localhost:3000):
 * menu → customize item → cart → checkout → order confirmation.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-customer.ts
 * Requires the store to be published with the seeded menu.
 */
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp";

async function main() {
  const browser = await chromium.launch({
    // Pre-installed browser in the sandbox; pinned version may not match the
    // installed playwright package, so point at the binary directly.
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const shot = (name: string) =>
    page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });

  // 1. Menu
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Specialty Pizzas");
  await shot("01-menu");

  // 2. Customize a pizza
  await page.click("text=Cheese Pizza");
  await page.waitForSelector('[role="dialog"]');
  await page.click('label:has-text("Large 14")');
  await page.click('label:has-text("Thin Crust")');
  await page.click('label:has-text("Pepperoni")');
  await page.click('label:has-text("Mushrooms")');
  await shot("02-customize");
  await page.click('button:has-text("Add 1 to cart")');
  await page.waitForSelector('[role="dialog"]', { state: "detached" });

  // Add a side without options
  await page.click("text=Garlic Knots (6)");
  await page.waitForSelector('[role="dialog"]');
  await page.click('button:has-text("Add 1 to cart")');
  await page.waitForSelector('[role="dialog"]', { state: "detached" });

  // 3. Cart
  await page.click('a[href="/cart"]');
  await page.waitForSelector("text=Your cart");
  await shot("03-cart");

  // 4. Checkout
  await page.click("text=Go to checkout");
  await page.waitForSelector("text=Order type");
  await page.fill("#co-name", "Ada Lovelace");
  await page.fill("#co-phone", "(555) 010-2233");
  await page.fill("#co-email", "ada@example.com");
  await shot("04-checkout");
  await page.click('button:has-text("Place pickup order")');

  // 5. Confirmation
  await page.waitForSelector("text=Order received", { timeout: 20_000 });
  await shot("05-confirmation");
  const orderText = await page.textContent("body");
  if (!orderText?.includes("Order details")) throw new Error("No order details on confirmation");

  await browser.close();
  console.log("CUSTOMER E2E PASSED — screenshots in", SHOT_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
