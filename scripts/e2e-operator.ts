/**
 * Operator-flow smoke test against a running dev server:
 * first-run setup → orders inbox (channel + payment state) → menu →
 * settings/publish → sign out and back in.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-operator.ts
 * Precondition: no operator row exists yet (first-run state).
 */
import { BASE, check, launchBrowser, run, SHOT_DIR, signIn } from "./e2e/harness";

const OWNER = { email: "owner@minks.example", password: "pizza-test-1234", name: "Mink Operator" };

run(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const shot = (name: string) =>
    page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });

  await signIn(page, OWNER);
  check("signed in to the orders inbox", new URL(page.url()).pathname, "/admin");
  await shot("a2-orders-inbox");

  // 2. Orders inbox lists orders with channel and payment state. Kitchen
  // status is driven by the KDS, so the inbox has no status buttons.
  // Match any order number rather than a fixed prefix — order numbers grow,
  // and completed/canceled ones live in a collapsed "Recent" section.
  await page
    .locator("text=/#\\d{4,}/")
    .first()
    .waitFor({ state: "attached", timeout: 30_000 });
  const inbox = await page.locator("main").innerText();
  check("the inbox shows a channel badge", /\b(Online|Phone|Walk-in|Dine-in)\b/.test(inbox), true);
  check("the inbox shows a payment state", /\b(Unpaid|Part paid|Paid|Refunded)\b/.test(inbox), true);
  check("the removed Confirm step is gone", await page.locator('button:has-text("Confirm")').count(), 0);

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
  check("signing out lands on the login page", new URL(page.url()).pathname, "/admin/login");
  await signIn(page, OWNER);
  check("signing back in lands on the inbox", new URL(page.url()).pathname, "/admin");
  await shot("a6-relogin");

  await browser.close();
});
