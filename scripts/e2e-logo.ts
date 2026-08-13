/**
 * Logo-upload e2e: operator uploads a logo in Settings, saves, and the
 * storefront header renders it instead of the initial badge.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-logo.ts
 * Requires a running dev server and an existing operator account.
 */
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp";
const EMAIL = process.env.E2E_EMAIL ?? "owner@minks.example";
const PASSWORD = process.env.E2E_PASSWORD ?? "pizza-test-1234";
const LOGO = "/tmp/e2e-test-logo.png";

async function main() {
  execFileSync("npx", ["tsx", "scripts/make-test-logo.ts", LOGO], {
    stdio: "inherit",
  });

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // Sign in.
  await page.goto(`${BASE}/admin/settings`, { waitUntil: "networkidle" });
  if (page.url().includes("/admin/login")) {
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/admin$/, { timeout: 20_000 });
    await page.goto(`${BASE}/admin/settings`, { waitUntil: "networkidle" });
  }

  // Upload: the file input is hidden behind the "Upload image" button.
  await page.waitForSelector("text=Logo");
  await page.setInputFiles('input[type="file"]', LOGO);
  await page.waitForFunction(
    () =>
      document
        .querySelector<HTMLInputElement>('input[name="logoUrl"]')
        ?.value.startsWith("data:image/") ?? false,
    undefined,
    { timeout: 15_000 },
  );
  await page.screenshot({ path: `${SHOT_DIR}/logo-1-settings.png` });

  await page.click('button[type="submit"]:has-text("Save")');
  await page.waitForURL(/saved=1/, { timeout: 20_000 });

  // Persisted?
  const stored = await page.getAttribute('input[name="logoUrl"]', "value");
  if (!stored?.startsWith("data:image/")) {
    throw new Error(`logo not persisted, got: ${String(stored).slice(0, 40)}`);
  }
  await page.screenshot({ path: `${SHOT_DIR}/logo-2-saved.png` });

  // Storefront header renders it.
  await page.goto(BASE, { waitUntil: "networkidle" });
  const headerLogo = page.locator('header img[alt]').first();
  await headerLogo.waitFor({ timeout: 15_000 });
  const src = await headerLogo.getAttribute("src");
  if (!src?.startsWith("data:image/")) {
    throw new Error(`storefront header not showing the logo: ${src?.slice(0, 40)}`);
  }
  await page.screenshot({ path: `${SHOT_DIR}/logo-3-storefront.png` });

  await browser.close();
  console.log("LOGO E2E PASSED — screenshots in", SHOT_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
