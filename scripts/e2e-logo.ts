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
const LOGO = process.env.E2E_LOGO ?? "/tmp/e2e-test-logo.png";

async function main() {
  // Only generate the built-in fixture; an explicit E2E_LOGO is used as-is.
  if (!process.env.E2E_LOGO) {
    execFileSync("npx", ["tsx", "scripts/make-test-logo.ts", LOGO], {
      stdio: "inherit",
    });
  }

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
  // Upload posts to /api/admin/logo; the preview flips to the asset route.
  await page
    .locator('img[alt="Current logo"][src^="/api/logo"]')
    .waitFor({ timeout: 20_000 });
  await page.screenshot({ path: `${SHOT_DIR}/logo-1-settings.png` });

  await page.click('button[type="submit"]:has-text("Save")');
  await page.waitForURL(/saved=1/, { timeout: 20_000 });

  // Survives a reload of the settings page?
  await page.reload({ waitUntil: "networkidle" });
  await page
    .locator('img[alt="Current logo"][src^="/api/logo"]')
    .waitFor({ timeout: 20_000 });
  await page.screenshot({ path: `${SHOT_DIR}/logo-2-saved.png` });

  // Storefront header renders it.
  await page.goto(BASE, { waitUntil: "networkidle" });
  const headerLogo = page.locator('header img[alt]').first();
  await headerLogo.waitFor({ timeout: 15_000 });
  const src = await headerLogo.getAttribute("src");
  if (!src?.startsWith("/api/logo")) {
    throw new Error(`storefront header not showing the logo: ${src?.slice(0, 60)}`);
  }
  // The asset route must actually serve the image bytes.
  const assetRes = await page.request.get(new URL(src, BASE).toString());
  if (!assetRes.ok() || !(assetRes.headers()["content-type"] ?? "").startsWith("image/")) {
    throw new Error(`asset route failed: ${assetRes.status()}`);
  }
  await page.screenshot({ path: `${SHOT_DIR}/logo-3-storefront.png` });

  await browser.close();
  console.log("LOGO E2E PASSED — screenshots in", SHOT_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
