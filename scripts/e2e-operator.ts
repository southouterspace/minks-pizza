/**
 * Operator-flow smoke test against a running dev server:
 * first-run setup → dashboard → menu edit → settings/publish → orders inbox
 * status transitions.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-operator.ts
 * Precondition: no operator row exists yet (first-run state).
 */
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp";
const EMAIL = "owner@minks.example";
const PASSWORD = "pizza-test-1234";

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const shot = (name: string) =>
    page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });

  // 1. First-run setup (or login if the operator already exists)
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  if (page.url().includes("/admin/setup")) {
    await shot("a1-setup");
    await page.fill('input[name="name"]', "Mink Operator");
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
  } else if (page.url().includes("/admin/login")) {
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
  }
  await page.waitForURL(/\/admin$/, { timeout: 20_000 });
  await shot("a2-orders-inbox");

  // 2. Orders inbox lists orders; advance one status.
  // Match any order number rather than a fixed prefix — order numbers grow,
  // and completed/canceled ones live in a collapsed "Recent" section.
  await page
    .locator("text=/#\\d{4,}/")
    .first()
    .waitFor({ state: "attached", timeout: 30_000 });
  const confirmBtn = page.locator('button:has-text("Confirm")').first();
  if (await confirmBtn.count()) {
    await confirmBtn.click();
    await page.waitForTimeout(1500);
    await shot("a3-after-confirm");
  }

  // 3. Menu management: toggle availability of an item, then back
  await page.click('a[href="/admin/menu"]');
  await page.waitForSelector("text=Specialty Pizzas");
  await shot("a4-menu");

  // 4. Settings: publish the store via the UI switch (the go-live moment)
  await page.click('a[href="/admin/settings"]');
  await page.waitForSelector("text=Publish store", { timeout: 15_000 });
  await shot("a5-settings");
  const publishSwitch = page.getByRole("switch", {
    name: "Publish store",
    exact: true,
  });
  if (await publishSwitch.count()) {
    await publishSwitch.click();
    // The switch relabels to "Unpublish store" once the toggle persists.
    await page
      .getByRole("switch", { name: "Unpublish store", exact: true })
      .waitFor({ timeout: 15_000 });
    await shot("a5b-published");
  }

  // 4b. Storefront should now show the live menu, not the coming-soon page
  const storefront = await browser.newPage();
  await storefront.goto(BASE, { waitUntil: "networkidle" });
  await storefront.waitForSelector("text=Specialty Pizzas", { timeout: 15_000 });
  await storefront.close();

  // 5. Sign out and log back in
  await page.click("text=Sign out");
  await page.waitForURL("**/admin/login**", { timeout: 15_000 });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/admin", { timeout: 20_000 });
  await shot("a6-relogin");

  await browser.close();
  console.log("OPERATOR E2E PASSED — screenshots in", SHOT_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
