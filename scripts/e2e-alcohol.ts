/**
 * Alcohol e2e against a running dev server and its database. Sparkling Water
 * stands in for a beer: marked 21+, the storefront badges it, checkout keeps
 * a cart holding it off delivery, the server refuses such a delivery order
 * and takes the pickup, the line snapshots the flag, and points (promised at
 * checkout or claimed afterwards, and the welcome bonus) leave it out. A
 * pizza-only delivery order still goes through.
 *
 * Run: NODE_PATH=scripts/shims npx tsx --env-file=.env.local scripts/e2e-alcohol.ts
 * Mutates orders, members and the loyalty settings, and flags Sparkling
 * Water until the end: point MINKS_DATABASE_URL at a test branch, not production.
 */
import { mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, loyaltySettings, menuItems, orderItems } from "../src/db";
import { createOrder, OrderError } from "../src/lib/checkout";
import { ALCOHOL_PICKUP_ONLY } from "../src/lib/orders";
import { claimOrderByNumber, enrollVerifiedMember } from "../src/lib/loyalty-server";
import { DEFAULT_TIERS } from "../src/lib/loyalty";
import {
  BASE,
  SHOT_DIR,
  check,
  fillCart,
  launchBrowser,
  ledgerOf,
  ledgerSummary,
  menuFixture,
  moveOrder,
  orderRow,
  run,
  uniquePhone,
} from "./e2e/harness";

const PROGRAM = {
  enabled: true,
  programName: "Mink's Rewards",
  pointsPerDollar: 10,
  signupBonus: 200,
  birthdayPoints: 700,
  referrerBonus: 500,
  refereeBonus: 300,
  expirationMonths: 12,
  tiers: DEFAULT_TIERS,
};

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => "placed",
    (err: unknown) => (err instanceof OrderError ? err.message : Promise.reject(err)),
  );

run(async () => {
  mkdirSync(SHOT_DIR, { recursive: true });
  const fixture = await menuFixture();
  const [water] = await db.select().from(menuItems).where(eq(menuItems.name, "Sparkling Water"));
  if (!water) throw new Error("Seed menu is missing Sparkling Water; run npm run db:seed");
  await db.update(menuItems).set({ isAlcoholic: true }).where(eq(menuItems.id, water.id));
  const [savedProgram] = await db.select().from(loyaltySettings);
  await db
    .insert(loyaltySettings)
    .values({ id: 1, ...PROGRAM })
    .onConflictDoUpdate({ target: loyaltySettings.id, set: PROGRAM });

  const waterLine = (quantity = 1) => ({ itemId: water.id, quantity, notes: null, selections: [] });
  const order = (phone: string, extra: Record<string, unknown> = {}) => ({
    orderType: "pickup" as const,
    customerName: "Ada Adult",
    customerPhone: phone,
    tipCents: 0,
    lines: [...fixture.orderLines, waterLine()],
    ...extra,
  });
  const delivery = { orderType: "delivery" as const, addressLine1: "1 Main St", city: "The Woodlands", zip: "77354" };

  try {
    const browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await fillCart(page, fixture.cartLine);
    await page.evaluate(() => localStorage.setItem("minks-order-type-v1", "pickup"));
    await page.goto(BASE, { waitUntil: "networkidle" });
    const card = page.locator('[role="button"]', { hasText: "Sparkling Water" });
    check("the menu card badges the drink 21+", await card.getByText("21+", { exact: true }).isVisible(), true);
    check(
      "a pizza card carries no 21+ badge",
      await page.locator('[role="button"]', { hasText: "Pepperoni Classic" }).getByText("21+", { exact: true }).count(),
      0,
    );
    await card.click();
    await page.waitForSelector('[role="dialog"]');
    check("the dialog says it is pickup only", await page.getByTestId("alcohol-note").textContent(), "21+ · Pickup only");
    await page.getByRole("button", { name: /^Add \d+ to cart/ }).click();
    await page.waitForSelector('[role="dialog"]', { state: "detached" });

    await page.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
    const deliveryButton = page.getByRole("button", { name: /^Delivery/ });
    await page.getByText("Not for alcohol").waitFor();
    check("delivery can't be picked with alcohol in the cart", await deliveryButton.isDisabled(), true);

    await page.evaluate(() => localStorage.setItem("minks-order-type-v1", "delivery"));
    await page.reload({ waitUntil: "networkidle" });
    await page.getByTestId("alcohol-pickup-only").waitFor();
    check("a cart left on delivery says why", await page.getByTestId("alcohol-pickup-only").textContent(), ALCOHOL_PICKUP_ONLY);
    check("and can't be placed", await page.getByTestId("place-order").isDisabled(), true);
    await page.screenshot({ path: `${SHOT_DIR}/alcohol-checkout-delivery.png`, fullPage: true });

    await page.getByRole("button", { name: /^Pickup/ }).click();
    await page.fill("#co-name", "Ada Adult");
    await page.fill("#co-phone", uniquePhone().display);
    await page.click('button:has-text("Place pickup order")');
    await page.waitForURL(/\/order\/[0-9a-f-]{36}/, { timeout: 20_000 });
    const uiOrderId = page.url().split("/order/")[1].split(/[?#]/)[0];
    check("the pickup order goes through from the storefront", (await orderRow(uiOrderId)).orderType, "pickup");
    await browser.close();

    const deliveryPhone = uniquePhone();
    check(
      "the server refuses a delivery order holding alcohol",
      await refusal(createOrder(order(deliveryPhone.display, delivery))),
      ALCOHOL_PICKUP_ONLY,
    );
    check(
      "a pizza-only delivery order still goes through",
      await refusal(createOrder({ ...order(deliveryPhone.display, delivery), lines: fixture.orderLines })),
      "placed",
    );

    const joining = uniquePhone();
    const placed = await createOrder(order(joining.display, { joinLoyalty: true }));
    const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, placed.id));
    check(
      "each line snapshots the item's 21+ flag",
      lines.map((l) => [l.itemName, l.isAlcoholic]).sort(),
      [["Pepperoni Classic", false], ["Sparkling Water", true]],
    );
    const row = await orderRow(placed.id);
    check("the pickup order's subtotal includes the drink", row.subtotalCents, 1999 + water.basePriceCents);
    check("checkout promises points on the pizza only", row.loyaltyPointsEarned, 199);

    const guest = uniquePhone();
    const knots = await createOrder({
      ...order(guest.display),
      lines: [...fixture.knotsLines, waterLine(4)],
    });
    await moveOrder(knots.id, "ready", "completed");
    const member = await enrollVerifiedMember(guest.digits, { name: "Gus Guest", referredById: null });
    check("a completed guest order is claimed", await claimOrderByNumber(member.id, knots.number), "claimed");
    check(
      "claimed points leave the drinks out, and so does the $15 welcome-bonus threshold",
      [(await orderRow(knots.id)).subtotalCents >= 1500, ledgerSummary(await ledgerOf(member.id))],
      [true, "earn:59"],
    );
  } finally {
    await db.update(menuItems).set({ isAlcoholic: false }).where(eq(menuItems.id, water.id));
    if (savedProgram) await db.update(loyaltySettings).set(savedProgram).where(eq(loyaltySettings.id, 1));
  }
});
