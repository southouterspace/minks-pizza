/**
 * Team-management smoke test against a running dev server:
 * sign in → add an operator → duplicate email rejected → the new operator can
 * sign in → change own password → sign in with the new password → owner
 * removes the account → self-removal is not offered.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-team.ts
 * Precondition: an operator exists with E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD.
 *
 * Point this at a throwaway database — it creates and deletes operator rows.
 */
import type { Page } from "playwright";
import { BASE, check, launchBrowser, run, SHOT_DIR, signIn } from "./e2e/harness";

const OWNER = {
  email: process.env.E2E_OWNER_EMAIL ?? "owner@minks.example",
  password: process.env.E2E_OWNER_PASSWORD ?? "pizza-test-1234",
  name: "Mink Operator",
};
const STAFF = { email: "dana@minks.example", password: "temp-pass-9876", name: "Dana Staff" };
const STAFF_NEW_PASSWORD = "dana-picked-this-1";

/** The operator row for one email. Rows carry data-testid="operator-row". */
function row(page: Page, email: string) {
  return page.getByTestId("operator-row").filter({ hasText: email });
}

async function signOut(page: Page) {
  await page.click("text=Sign out");
  await page.waitForURL("**/admin/login**", { timeout: 15_000 });
}

/** Whether the page shows this exact message. */
const shows = (page: Page, text: string) => page.getByText(text, { exact: true }).isVisible();

run(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const shot = (name: string) =>
    page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });

  // 1. Owner reaches the Team page from the nav.
  await signIn(page, OWNER);
  await page.click('a[href="/admin/team"]');
  await page.waitForURL("**/admin/team", { timeout: 15_000 });
  await page.waitForSelector("text=Add an operator", { timeout: 15_000 });

  // Start clean: a previous aborted run may have left the staff account behind.
  const leftover = row(page, STAFF.email);
  if (await leftover.count()) {
    await leftover.locator('button:has-text("Remove")').click();
    await leftover.locator('button:has-text("Confirm remove")').click();
    await page.waitForSelector("text=Account removed.", { timeout: 20_000 });
    console.log("  (cleaned up a leftover staff account)");
  }
  await shot("t1-team");

  // 2. The signed-in operator is badged and has no Remove button — that guard
  //    is what keeps the store from ever reaching zero accounts.
  const ownerRow = row(page, OWNER.email);
  check("your own row is listed", await ownerRow.isVisible(), true);
  check("your own row carries the You badge", await ownerRow.getByText("You").count(), 1);
  check("no Remove button on your own row", await ownerRow.locator('button:has-text("Remove")').count(), 0);
  // Exactly one row, yours, is un-removable, whatever the team size.
  const rowCount = await page.getByTestId("operator-row").count();
  check(`every row but your own offers Remove (${rowCount} rows)`, await page.locator('button:has-text("Remove")').count(), rowCount - 1);

  // 3. Add an operator.
  // Scoped: Team also has an Add employee form with its own name field.
  const addOperator = page.locator('form:has(button:has-text("Add operator"))');
  await addOperator.locator('input[name="name"]').fill(STAFF.name);
  await addOperator.locator('input[name="email"]').fill(STAFF.email);
  await addOperator.locator('input[name="password"]').fill(STAFF.password);
  await addOperator.locator('button:has-text("Add operator")').click();
  await page.waitForSelector("text=Account created.", { timeout: 20_000 });
  check("new operator is listed", await row(page, STAFF.email).isVisible(), true);
  check("the other operator's row does offer Remove", await row(page, STAFF.email).locator('button:has-text("Remove")').count(), 1);
  await shot("t2-added");

  // 4. The same email a second time is refused rather than 500ing on the
  //    unique index.
  await addOperator.locator('input[name="name"]').fill("Impostor");
  await addOperator.locator('input[name="email"]').fill(STAFF.email.toUpperCase());
  await addOperator.locator('input[name="password"]').fill("another-pass-1");
  await addOperator.locator('button:has-text("Add operator")').click();
  await page.waitForSelector("text=That email already has an account.", {
    timeout: 20_000,
  });
  check("duplicate email rejected (and case-insensitively)", await shows(page, "That email already has an account."), true);
  await shot("t3-duplicate");

  // 5. The new operator can sign in with the password the owner set.
  await page.goto(`${BASE}/admin/team`, { waitUntil: "networkidle" });
  await signOut(page);
  await signIn(page, STAFF);
  check("new operator signed in", new URL(page.url()).pathname, "/admin");

  // 6. …and can replace that password with one the owner doesn't know.
  await page.goto(`${BASE}/admin/team`, { waitUntil: "networkidle" });
  await page.fill('input[name="currentPassword"]', "wrong-password");
  await page.fill('input[name="newPassword"]', STAFF_NEW_PASSWORD);
  await page.click('button:has-text("Update password")');
  await page.waitForSelector("text=That's not your current password.", {
    timeout: 20_000,
  });
  check("wrong current password is refused", await shows(page, "That's not your current password."), true);

  await page.fill('input[name="currentPassword"]', STAFF.password);
  await page.fill('input[name="newPassword"]', STAFF_NEW_PASSWORD);
  await page.click('button:has-text("Update password")');
  await page.waitForSelector("text=Your password was updated.", {
    timeout: 20_000,
  });
  await shot("t4-password-changed");

  await signOut(page);
  await signIn(page, { ...STAFF, password: STAFF_NEW_PASSWORD });
  check("new password works", new URL(page.url()).pathname, "/admin");

  // 7. Owner removes the account.
  await signOut(page);
  await signIn(page, OWNER, "/admin/team");
  const staffRow = row(page, STAFF.email);
  await staffRow.locator('button:has-text("Remove")').click();
  await staffRow.locator('button:has-text("Confirm remove")').click();
  await page.waitForSelector("text=Account removed.", { timeout: 20_000 });
  check("removed operator is gone from the list", await row(page, STAFF.email).count(), 0);
  await shot("t5-removed");

  // 8. The removed operator can no longer sign in.
  await signOut(page);
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', STAFF.email);
  await page.fill('input[name="password"]', STAFF_NEW_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector("text=Invalid email or password.", {
    timeout: 20_000,
  });
  check("removed operator can no longer sign in", await shows(page, "Invalid email or password."), true);

  await browser.close();
});
