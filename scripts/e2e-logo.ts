/**
 * Logo-upload e2e: operator uploads a logo in Settings, saves, and the
 * storefront header renders it instead of the initial badge.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-logo.ts
 * Requires a running dev server and an existing operator account.
 */
import { execFileSync } from "node:child_process";
import { BASE, check, launchBrowser, run, SHOT_DIR, signIn } from "./e2e/harness";

const OWNER = {
  email: process.env.E2E_EMAIL ?? "owner@minks.example",
  password: process.env.E2E_PASSWORD ?? "pizza-test-1234",
  name: "Mink Operator",
};
const LOGO = process.env.E2E_LOGO ?? "/tmp/e2e-test-logo.png";

run(async () => {
  // Only generate the built-in fixture; an explicit E2E_LOGO is used as-is.
  if (!process.env.E2E_LOGO) {
    execFileSync("npx", ["tsx", "scripts/make-test-logo.ts", LOGO], {
      stdio: "inherit",
    });
  }

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await signIn(page, OWNER, "/admin/settings");

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
  const src = (await headerLogo.getAttribute("src")) ?? "";
  check("the storefront header shows the uploaded logo", new URL(src, BASE).pathname, "/api/logo");
  const asset = await page.request.get(new URL(src, BASE).toString());
  check("the asset route serves the image", [asset.status(), asset.headers()["content-type"]], [200, "image/png"]);
  await page.screenshot({ path: `${SHOT_DIR}/logo-3-storefront.png` });

  await browser.close();
});
