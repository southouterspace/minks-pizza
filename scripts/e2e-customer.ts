/**
 * Customer-flow smoke test against a running dev server:
 * menu → customize item → cart → checkout → order confirmation, whose
 * ready-by time reads in the store's timezone.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-customer.ts
 * Requires the store to be published with the seeded menu, an 8.25% tax
 * rate and the America/Chicago timezone.
 */
import { eq } from "drizzle-orm";
import { db, orders } from "../src/db";
import { BASE, check, launchBrowser, run, SHOT_DIR } from "./harness";

run(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Tokyo" });
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
  const orderId = new URL(page.url()).pathname.split("/").pop() ?? "";
  const [placed] = await db.select().from(orders).where(eq(orders.id, orderId));
  const details = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  check("tracker heads the order with its number and fulfillment", details.includes(`Order #${placed.orderNumber} · Pickup`), true);
  check(
    "tracker lists the pie with its options and toppings",
    details.includes('1× Cheese Pizza Size: Large 14" · Crust: Thin Crust · Pepperoni · Mushrooms'),
    true,
  );
  check("tracker shows the balance due at pickup", details.includes("Payment $32.32 due at pickup"), true);
  // Neither the browser's zone (Tokyo) nor the server's (UTC): a wrong zone shows.
  const readyBy = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }).format(placed.promisedAt ?? undefined);
  check("tracker's ready-by time reads in the store's zone", details.includes(`Estimated ready by ${readyBy}`), true);

  await browser.close();
});
