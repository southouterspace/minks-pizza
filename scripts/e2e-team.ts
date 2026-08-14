/**
 * Team-management smoke test against a running dev server:
 * sign in → add an operator → duplicate email rejected → the new operator can
 * sign in → change own password → sign in with the new password → owner
 * removes the account → self-removal is not offered.
 *
 * Run: npx tsx --env-file=.env.e2e scripts/e2e-team.ts
 * Precondition: an operator exists with OWNER_EMAIL / OWNER_PASSWORD.
 *
 * Point this at a throwaway database — it creates and deletes operator rows.
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp";
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL ?? "owner@minks.example";
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? "pizza-test-1234";

const STAFF_NAME = "Dana Staff";
const STAFF_EMAIL = "dana@minks.example";
const STAFF_PASSWORD = "temp-pass-9876";
const STAFF_NEW_PASSWORD = "dana-picked-this-1";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

/** The operator row for one email. Rows carry data-testid="operator-row". */
function row(page: Page, email: string) {
  return page.getByTestId("operator-row").filter({ hasText: email });
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin$/, { timeout: 20_000 });
}

async function signOut(page: Page) {
  await page.click("text=Sign out");
  await page.waitForURL("**/admin/login**", { timeout: 15_000 });
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const shot = (name: string) =>
    page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });

  // 1. Owner reaches the Team page from the nav.
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  await page.click('a[href="/admin/team"]');
  await page.waitForURL("**/admin/team", { timeout: 15_000 });
  await page.waitForSelector("text=Add an operator", { timeout: 15_000 });

  // Start clean: a previous aborted run may have left the staff account behind.
  const leftover = row(page, STAFF_EMAIL);
  if (await leftover.count()) {
    await leftover.locator('button:has-text("Remove")').click();
    await leftover.locator('button:has-text("Confirm remove")').click();
    await page.waitForSelector("text=Account removed.", { timeout: 20_000 });
    console.log("  (cleaned up a leftover staff account)");
  }
  await shot("t1-team");

  // 2. The signed-in operator is badged and has no Remove button — that guard
  //    is what keeps the store from ever reaching zero accounts.
  const ownerRow = row(page, OWNER_EMAIL);
  check(await ownerRow.isVisible(), "your own row is listed");
  check(
    (await ownerRow.getByText("You").count()) === 1,
    "your own row carries the You badge",
  );
  check(
    (await ownerRow.locator('button:has-text("Remove")').count()) === 0,
    "no Remove button on your own row",
  );
  // Exactly one row — yours — is un-removable, whatever the team size.
  const rowCount = await page.getByTestId("operator-row").count();
  check(
    (await page.locator('button:has-text("Remove")').count()) === rowCount - 1,
    `every row but your own offers Remove (${rowCount} rows)`,
  );

  // 3. Add an operator.
  await page.fill('input[name="name"]', STAFF_NAME);
  await page.fill('input[name="email"]', STAFF_EMAIL);
  await page.fill('input[name="password"]', STAFF_PASSWORD);
  await page.click('button:has-text("Add operator")');
  await page.waitForSelector("text=Account created.", { timeout: 20_000 });
  check(await row(page, STAFF_EMAIL).isVisible(), "new operator is listed");
  check(
    (await row(page, STAFF_EMAIL)
      .locator('button:has-text("Remove")')
      .count()) === 1,
    "the other operator's row does offer Remove",
  );
  await shot("t2-added");

  // 4. The same email a second time is refused rather than 500ing on the
  //    unique index.
  await page.fill('input[name="name"]', "Impostor");
  await page.fill('input[name="email"]', STAFF_EMAIL.toUpperCase());
  await page.fill('input[name="password"]', "another-pass-1");
  await page.click('button:has-text("Add operator")');
  await page.waitForSelector("text=That email already has an account.", {
    timeout: 20_000,
  });
  check(true, "duplicate email rejected (and case-insensitively)");
  await shot("t3-duplicate");

  // 5. The new operator can sign in with the password the owner set.
  await page.goto(`${BASE}/admin/team`, { waitUntil: "networkidle" });
  await signOut(page);
  await signIn(page, STAFF_EMAIL, STAFF_PASSWORD);
  check(page.url().endsWith("/admin"), "new operator signed in");

  // 6. …and can replace that password with one the owner doesn't know.
  await page.goto(`${BASE}/admin/team`, { waitUntil: "networkidle" });
  await page.fill('input[name="currentPassword"]', "wrong-password");
  await page.fill('input[name="newPassword"]', STAFF_NEW_PASSWORD);
  await page.click('button:has-text("Update password")');
  await page.waitForSelector("text=That's not your current password.", {
    timeout: 20_000,
  });
  check(true, "wrong current password is refused");

  await page.fill('input[name="currentPassword"]', STAFF_PASSWORD);
  await page.fill('input[name="newPassword"]', STAFF_NEW_PASSWORD);
  await page.click('button:has-text("Update password")');
  await page.waitForSelector("text=Your password was updated.", {
    timeout: 20_000,
  });
  await shot("t4-password-changed");

  await signOut(page);
  await signIn(page, STAFF_EMAIL, STAFF_NEW_PASSWORD);
  check(page.url().endsWith("/admin"), "new password works");

  // 7. Owner removes the account.
  await signOut(page);
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  await page.goto(`${BASE}/admin/team`, { waitUntil: "networkidle" });
  const staffRow = row(page, STAFF_EMAIL);
  await staffRow.locator('button:has-text("Remove")').click();
  await staffRow.locator('button:has-text("Confirm remove")').click();
  await page.waitForSelector("text=Account removed.", { timeout: 20_000 });
  check(
    (await row(page, STAFF_EMAIL).count()) === 0,
    "removed operator is gone from the list",
  );
  await shot("t5-removed");

  // 8. The removed operator can no longer sign in.
  await signOut(page);
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', STAFF_EMAIL);
  await page.fill('input[name="password"]', STAFF_NEW_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector("text=Invalid email or password.", {
    timeout: 20_000,
  });
  check(true, "removed operator can no longer sign in");

  await browser.close();
  console.log("TEAM E2E PASSED — screenshots in", SHOT_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
