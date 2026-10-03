/**
 * Promotions e2e against a running server and its database: an operator
 * builds a code deal and an automatic free-delivery deal in the admin; a
 * customer arrives on a /?promo= link, edits the cart, sees the reasons a
 * code doesn't apply, and checks out; per-customer and total limits hold
 * (including two checkouts racing for the last use); a cancel gives the use
 * back; an operator comp updates the totals and the timeline; the CSV export
 * carries the discount. Asserts the screen and what the database recorded.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-promotions.ts
 * Mutates orders, promotions and operators: point MINKS_DATABASE_URL at a
 * test branch, not production.
 */
import { mkdirSync } from "node:fs";
import bcrypt from "bcryptjs";
import { chromium, type Browser, type Page } from "playwright";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  db,
  menuItems,
  orderDiscounts,
  orderEvents,
  orders,
  operators,
  promotionCodes,
  promotions,
  storeSettings,
} from "../src/db";
import { createOrder } from "../src/lib/checkout";
import { OrderError } from "../src/lib/orders";
import { checkoutSchema } from "../src/lib/validation";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp/e2e-promotions";

/** The placeOrder action for a guest, without the session read the action makes. */
async function placeOrder(input: unknown): Promise<{ ok: true; orderId: string } | { ok: false; error: string }> {
  const parsed = checkoutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid order." };
  try {
    return { ok: true, orderId: (await createOrder(parsed.data)).id };
  } catch (err) {
    if (err instanceof OrderError) return { ok: false, error: err.message };
    throw err;
  }
}
const EMAIL = "promotions-e2e@minks.example";
const NAME = "Promo Tester";
const PASSWORD = "pizza-test-1234";
const PHONE_DIGITS = `555${String(Date.now()).slice(-7)}`;
const PHONE_PRETTY = `(${PHONE_DIGITS.slice(0, 3)}) ${PHONE_DIGITS.slice(3, 6)}-${PHONE_DIGITS.slice(6)}`;
const PHONE_DOTS = `${PHONE_DIGITS.slice(0, 3)}.${PHONE_DIGITS.slice(3, 6)}.${PHONE_DIGITS.slice(6)}`;

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes++;
  else failures++;
}

async function eventually(fn: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fn().catch(() => false);
}

const textOf = (page: Page, testId: string) =>
  page.getByTestId(testId).allInnerTexts().then((t) => t.join(" | "));

const shows = (page: Page, testId: string, text: string) =>
  eventually(async () => (await textOf(page, testId)).includes(text));

async function noSideScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

async function signIn(browser: Browser, width = 1366): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin$/);
  return page;
}

async function cart(page: Page, lines: { itemId: number; name: string; price: number; quantity: number }[]) {
  await page.evaluate(
    (ls) =>
      localStorage.setItem(
        "minks-cart-v1",
        JSON.stringify(ls.map((l) => ({ key: `${l.itemId}::`, itemId: l.itemId, itemName: l.name, unitPriceCents: l.price, quantity: l.quantity, modifiers: [] }))),
      ),
    lines,
  );
}

async function ledger(orderId: string) {
  return db.select().from(orderDiscounts).where(eq(orderDiscounts.orderId, orderId));
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const [settings] = await db.select().from(storeSettings);
  check(
    "store fixture: published, 8.25% tax, pickup and delivery on",
    settings.isPublished && settings.taxRateBps === 825 && settings.pickupEnabled && settings.deliveryEnabled,
    `tax ${settings.taxRateBps}`,
  );
  await db.delete(promotions).where(like(promotions.name, "E2E %"));
  await db.delete(operators).where(eq(operators.email, EMAIL));
  await db.insert(operators).values({ email: EMAIL, name: NAME, passwordHash: await bcrypt.hash(PASSWORD, 10) });
  const [knots] = await db.select().from(menuItems).where(eq(menuItems.name, "Garlic Knots (6)"));
  const knot = (quantity: number) => ({ itemId: knots.id, name: knots.name, price: knots.basePriceCents, quantity });
  check("menu fixture: knots are $5.99", knots.basePriceCents === 599);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
  const admin = await signIn(browser);
  admin.on("pageerror", (e) => console.log("pageerror:", e.message));
  admin.on("console", async (m) => {
    if (m.type() !== "error") return;
    const args = await Promise.all(m.args().map((a) => a.evaluate((v) => (v instanceof Error ? `${v.message}\n${v.stack}` : String(v))).catch(() => "?")));
    console.log("console:", args.join(" ").slice(0, 1500));
  });

  // Operator builds a code deal from a template.
  await admin.goto(`${BASE}/admin/promotions/new`, { waitUntil: "networkidle" });
  await admin.getByRole("button", { name: "Percent off order" }).click();
  await admin.fill("#promo-name", "E2E 20% off $30+");
  await admin.getByRole("button", { name: "With a code" }).click();
  await admin.fill("#promo-code", "e2e-pizza");
  await admin.fill("#promo-percent", "20");
  await admin.fill("#promo-min", "30");
  await admin.fill("#promo-per-customer", "1");
  await admin.getByText("Combines with other combinable deals").click();
  check(
    "live preview sentence reads like the customer will see it",
    await shows(admin, "promo-preview", "20% off orders $30+. Once per customer. Use code E2E-PIZZA."),
    await textOf(admin, "promo-preview"),
  );
  await admin.screenshot({ path: `${SHOT_DIR}/admin-new-code-deal.png`, fullPage: true });
  await admin.getByTestId("save-promotion").click();
  await admin.waitForURL(/\/admin\/promotions\/\d+\?saved=1/);
  const [codeDeal] = await db.select().from(promotions).where(eq(promotions.name, "E2E 20% off $30+"));
  const [code] = await db.select().from(promotionCodes).where(eq(promotionCodes.promotionId, codeDeal.id));
  check(
    "code deal saved with its reward and conditions",
    JSON.stringify(codeDeal.reward) === JSON.stringify({ type: "order_percent", percentBps: 2000, maxDiscountCents: null }) &&
      codeDeal.minSubtotalCents === 3000 &&
      codeDeal.perCustomerLimit === 1 &&
      codeDeal.stackable &&
      codeDeal.trigger === "code",
    JSON.stringify(codeDeal.reward),
  );
  check("code stored normalized with its display form", code?.code === "E2EPIZZA" && code.display === "E2E-PIZZA");

  // Single-use batch and its CSV.
  await admin.fill("#gen-count", "5");
  await admin.getByRole("button", { name: "Generate single-use codes" }).click();
  check(
    "five single-use codes generated",
    await eventually(async () => (await db.select().from(promotionCodes).where(and(eq(promotionCodes.promotionId, codeDeal.id), eq(promotionCodes.maxUses, 1)))).length === 5),
  );
  const codesCsv = await (await admin.request.get(`${BASE}/api/admin/promotions/${codeDeal.id}/codes`)).text();
  const csvRows = codesCsv.trim().split("\r\n");
  check("codes CSV lists the shared code and the batch", csvRows.length === 7 && /^MINK-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{2},1,0$/.test(csvRows[2]), csvRows[2]);
  await admin.getByLabel("Shared code").fill("e2e pizza");
  await admin.getByRole("button", { name: "Add code" }).click();
  check(
    "a duplicate code gets a friendly error",
    await eventually(async () => (await admin.locator("[data-sonner-toast]").allInnerTexts()).join(" ").includes("E2E PIZZA is already taken")),
  );

  // Operator builds an automatic free-delivery deal.
  await admin.goto(`${BASE}/admin/promotions/new`, { waitUntil: "networkidle" });
  await admin.getByRole("button", { name: "Free delivery" }).click();
  await admin.fill("#promo-name", "E2E Free delivery $30+");
  await admin.getByText("Combines with other combinable deals").click();
  await admin.getByTestId("save-promotion").click();
  await admin.waitForURL(/\/admin\/promotions\/\d+\?saved=1/);
  const [freeDeal] = await db.select().from(promotions).where(eq(promotions.name, "E2E Free delivery $30+"));
  check(
    "free delivery saved as automatic, delivery only, $30 minimum",
    freeDeal?.trigger === "automatic" && freeDeal.reward.type === "free_delivery" && JSON.stringify(freeDeal.orderTypes) === '["delivery"]' && freeDeal.minSubtotalCents === 3000,
  );

  // Customer arrives on a shared link.
  const shopper = await browser.newPage({ viewport: { width: 375, height: 800 } });
  await shopper.goto(`${BASE}/?promo=e2e-pizza`, { waitUntil: "networkidle" });
  check(
    "promo link toasts that the code was added",
    await eventually(async () => (await shopper.locator("[data-sonner-toast]").allInnerTexts()).join(" ").includes("Code E2E-PIZZA added — applies at checkout")),
  );
  check("promo param is stripped from the URL", !shopper.url().includes("promo="));
  check("deals strip shows the advertised code", await shows(shopper, "deal", "E2E-PIZZA"));
  await shopper.screenshot({ path: `${SHOT_DIR}/store-deals-375.png` });
  check("menu: no sideways scroll at 375px", await noSideScroll(shopper));

  await cart(shopper, [knot(1)]);
  await shopper.goto(`${BASE}/cart`, { waitUntil: "networkidle" });
  check(
    "under the minimum, the code stays attached with a specific reason",
    await shows(shopper, "promo-rejected", "Add $24.01 more to use E2E-PIZZA"),
    await textOf(shopper, "promo-rejected"),
  );
  await shopper.screenshot({ path: `${SHOT_DIR}/cart-under-minimum-375.png`, fullPage: true });
  for (let i = 0; i < 5; i++) await shopper.getByRole("button", { name: "Increase quantity of Garlic Knots (6)" }).click();
  check(
    "after the edit the code re-applies on its own: 20% of $35.94",
    await shows(shopper, "discount-line", "−$7.19"),
    await textOf(shopper, "discount-line"),
  );
  await shopper.reload({ waitUntil: "networkidle" });
  check("the code survives a refresh", await shows(shopper, "discount-line", "E2E-PIZZA"));
  check("cart: no sideways scroll at 375px", await noSideScroll(shopper));
  await shopper.screenshot({ path: `${SHOT_DIR}/cart-applied-375.png`, fullPage: true });

  await shopper.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
  await shopper.fill("#co-name", "Penny Promo");
  await shopper.fill("#co-phone", PHONE_PRETTY);
  await shopper.getByRole("button", { name: "No tip" }).click();
  await shopper.getByRole("button", { name: /^Delivery/ }).click();
  check(
    "delivery adds the automatic deal, labeled as such",
    await shows(shopper, "discount-line", "Applied automatically"),
    await textOf(shopper, "discount-line"),
  );
  await shopper.getByRole("button", { name: /^Pickup/ }).click();
  // 3594 − 719 = 2875; tax 8.25% = 237.19 → 237; total 3112.
  check(
    "button total matches the server quote",
    await eventually(async () => (await shopper.getByTestId("place-order").innerText()).includes("$31.12")),
    await shopper.getByTestId("place-order").innerText(),
  );
  check("checkout: no sideways scroll at 375px", await noSideScroll(shopper));
  await shopper.screenshot({ path: `${SHOT_DIR}/checkout-375.png`, fullPage: true });
  await shopper.getByTestId("place-order").click();
  await shopper.waitForURL(/\/order\/[0-9a-f-]{36}$/);
  const firstId = shopper.url().split("/").pop()!;
  check("confirmation says what was saved", await shows(shopper, "you-saved", "You saved $7.19"));
  check("confirmation lists the deal", await shows(shopper, "discount-line", "E2E 20% off $30+"));
  check("tracker: no sideways scroll at 375px", await noSideScroll(shopper));
  await shopper.screenshot({ path: `${SHOT_DIR}/confirmation-375.png`, fullPage: true });

  const [first] = await db.select().from(orders).where(eq(orders.id, firstId));
  check(
    "order row: gross subtotal, discount, tax on the discounted items, total",
    first.subtotalCents === 3594 && first.discountCents === 719 && first.taxCents === 237 && first.totalCents === 3112,
    `${first.subtotalCents}/${first.discountCents}/${first.taxCents}/${first.totalCents}`,
  );
  const firstLedger = await ledger(firstId);
  check(
    "one ledger row: promotion, code, amount; the order carries the phone key",
    firstLedger.length === 1 &&
      firstLedger[0].promotionId === codeDeal.id &&
      firstLedger[0].codeId === code.id &&
      firstLedger[0].amountCents === 719 &&
      firstLedger[0].target === "items" &&
      firstLedger[0].source === "promotion" &&
      first.customerKey === PHONE_DIGITS,
    JSON.stringify(firstLedger[0]),
  );

  // Same phone, different formatting: the per-customer limit holds.
  await shopper.goto(`${BASE}/?promo=E2EPIZZA`, { waitUntil: "networkidle" });
  await cart(shopper, [knot(6)]);
  await shopper.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
  await shopper.fill("#co-name", "Penny Promo");
  await shopper.fill("#co-phone", PHONE_DOTS);
  await shopper.getByRole("button", { name: "No tip" }).click();
  check(
    "a second order on the same phone is told why",
    await shows(shopper, "promo-rejected", "Already used with this phone number"),
    await textOf(shopper, "promo-rejected"),
  );
  // 3594 + 8.25% (296.5 → 297) = 3891.
  check(
    "and its total no longer counts the discount",
    await eventually(async () => (await shopper.getByTestId("place-order").innerText()).includes("$38.91")),
  );
  await shopper.screenshot({ path: `${SHOT_DIR}/checkout-limit-375.png`, fullPage: true });
  const sneaky = await placeOrder({
    orderType: "pickup",
    customerName: "Penny Promo",
    customerPhone: `+1 ${PHONE_DOTS}`,
    tipCents: 0,
    lines: [{ itemId: knots.id, quantity: 6, modifierIds: [] }],
    promoCodes: ["e2e-pizza"],
    expectedTotalCents: 3112,
  });
  check(
    "the server refuses the discounted total for that phone",
    !sneaky.ok && sneaky.error.includes("Already used with this phone number") && sneaky.error.includes("$38.91"),
    sneaky.ok ? "placed" : sneaky.error,
  );

  // Canceling the first order gives the use back.
  await db.update(orders).set({ status: "canceled", canceledAt: new Date() }).where(eq(orders.id, firstId));
  await shopper.fill("#co-phone", PHONE_PRETTY);
  check("after the cancel the code applies again", await shows(shopper, "discount-line", "−$7.19"));
  await eventually(async () => (await shopper.getByTestId("place-order").innerText()).includes("$31.12"));
  await shopper.getByTestId("place-order").click();
  await shopper.waitForURL(/\/order\/[0-9a-f-]{36}$/);
  const secondId = shopper.url().split("/").pop()!;
  check("the re-order carries the discount", (await ledger(secondId))[0]?.amountCents === 719);

  // Two checkouts race for the last use. When one quotes after the other has
  // committed, it legitimately places without the deal and nothing raced;
  // those rounds are checked for a single redemption and the race is re-run.
  const racer = (code: string, phone: string) =>
    placeOrder({
      orderType: "pickup",
      customerName: "Racer",
      customerPhone: phone,
      tipCents: 0,
      lines: [{ itemId: knots.id, quantity: 1, modifierIds: [] }],
      promoCodes: [code],
    });
  const raceOrders: string[] = [];
  let race: typeof promotions.$inferSelect | undefined;
  let results: Awaited<ReturnType<typeof racer>>[] = [];
  let round = 0;
  while (round < 5) {
    round++;
    [race] = await db
      .insert(promotions)
      .values({ name: `E2E Race $2 #${round}`, trigger: "code", reward: { type: "order_amount", amountCents: 200 }, orderTypes: ["pickup", "delivery"], totalLimit: 1, advertised: false })
      .returning();
    await db.insert(promotionCodes).values({ promotionId: race.id, code: `E2ERACE${round}`, display: `E2E-RACE${round}` });
    results = await Promise.all([racer(`E2E-RACE${round}`, "5550101001"), racer(`E2E-RACE${round}`, "5550101002")]);
    raceOrders.push(...results.flatMap((r) => (r.ok ? [r.orderId] : [])));
    check(
      `race round ${round}: the ledger has one redemption`,
      (await db.select().from(orderDiscounts).where(eq(orderDiscounts.promotionId, race.id))).length === 1,
    );
    if (!results.every((r) => r.ok)) break;
  }
  const winners = results.filter((r) => r.ok);
  const loser = results.find((r) => !r.ok);
  check("exactly one racer gets the last use", winners.length === 1, JSON.stringify(results));
  check(
    "the other is told exactly what happened",
    loser !== undefined && !loser.ok && loser.error === `E2E-RACE${round} was just fully redeemed — your total is now $6.48.`,
    loser && !loser.ok ? loser.error : "",
  );

  // Operator comp on the order detail page.
  const detail = await signIn(browser, 375);
  await detail.goto(`${BASE}/admin/orders/${secondId}`, { waitUntil: "networkidle" });
  await detail.getByTestId("apply-discount").click();
  await detail.getByLabel("Amount ($)").fill("3");
  await detail.getByLabel("Reason (on the receipt)").fill("Late order");
  await detail.getByTestId("confirm-discount").click();
  // Items 3594 − 719 − 300 = 2575; tax 212.44 → 212; total 2787.
  check(
    "comp rewrites discount, tax and total",
    await eventually(async () => {
      const [o] = await db.select().from(orders).where(eq(orders.id, secondId));
      return o.discountCents === 1019 && o.taxCents === 212 && o.totalCents === 2787;
    }),
  );
  const compEvent = (await db.select().from(orderEvents).where(eq(orderEvents.orderId, secondId))).find((e) => e.type === "discount");
  check("comp logs a discount event by the operator", compEvent?.note === "−$3.00 · Late order" && compEvent.actor === NAME);
  check("timeline shows the comp", await shows(detail, "timeline", "Discount · −$3.00 · Late order"));
  check("detail totals list both discounts", await shows(detail, "discount-line", "Late order"));
  check("order detail: no sideways scroll at 375px", await noSideScroll(detail));
  await detail.screenshot({ path: `${SHOT_DIR}/admin-order-comp-375.png`, fullPage: true });

  const [second] = await db.select().from(orders).where(eq(orders.id, secondId));
  const csv = await (await detail.request.get(`${BASE}/api/admin/orders/export?q=${second.orderNumber}`)).text();
  const [header, row] = csv.trim().split("\r\n");
  check("CSV has Discount columns", header.includes("Subtotal,Discount,Discounts,Tax"), header);
  check("CSV row carries the discount and its lines", row?.includes("35.94,10.19,E2E 20% off $30+; Late order,2.12"), row);

  // A comp from a deal's preset is reported under the deal but leaves its limit alone.
  const [compDeal] = await db
    .insert(promotions)
    .values({ name: "E2E Comp $1", trigger: "code", reward: { type: "order_amount", amountCents: 100 }, orderTypes: ["pickup", "delivery"], totalLimit: 1, advertised: false })
    .returning();
  await db.insert(promotionCodes).values({ promotionId: compDeal.id, code: "E2ECOMP", display: "E2E-COMP" });
  await detail.reload({ waitUntil: "networkidle" });
  await detail.getByTestId("apply-discount").click();
  await detail.getByRole("button", { name: "E2E Comp $1", exact: true }).click();
  await detail.getByTestId("confirm-discount").click();
  check(
    "a preset comp is recorded against its deal",
    await eventually(async () => (await db.select().from(orderDiscounts).where(and(eq(orderDiscounts.promotionId, compDeal.id), eq(orderDiscounts.source, "comp")))).length === 1),
  );
  const afterComp = await placeOrder({
    orderType: "pickup",
    customerName: "Comp Check",
    customerPhone: "5550102003",
    tipCents: 0,
    lines: [{ itemId: knots.id, quantity: 1, modifierIds: [] }],
    promoCodes: ["E2E-COMP"],
  });
  const afterCompLedger = afterComp.ok ? await ledger(afterComp.orderId) : [];
  check(
    "the comp didn't use up the deal's one redemption",
    afterCompLedger.length === 1 && afterCompLedger[0].promotionId === compDeal.id && afterCompLedger[0].source === "promotion",
    afterComp.ok ? JSON.stringify(afterCompLedger) : afterComp.error,
  );

  // Operator list numbers.
  await detail.goto(`${BASE}/admin/promotions`, { waitUntil: "networkidle" });
  check(
    "list counts uses over non-canceled orders",
    await shows(detail, `promotion-${codeDeal.id}`, "Uses\n1"),
    await textOf(detail, `promotion-${codeDeal.id}`),
  );
  check("race deal shows Used up", await shows(detail, `promotion-${race!.id}`, "Used up"));
  check(
    "the comp deal counts one use and both discounts",
    (await shows(detail, `promotion-${compDeal.id}`, "Uses\n1 / 1")) && (await shows(detail, `promotion-${compDeal.id}`, "Discounted\n$2.00")),
    await textOf(detail, `promotion-${compDeal.id}`),
  );
  check("promotions list: no sideways scroll at 375px", await noSideScroll(detail));
  await detail.screenshot({ path: `${SHOT_DIR}/admin-promotions-375.png`, fullPage: true });
  await admin.goto(`${BASE}/admin/promotions`, { waitUntil: "networkidle" });
  await admin.screenshot({ path: `${SHOT_DIR}/admin-promotions-desktop.png`, fullPage: true });
  await admin.goto(`${BASE}/admin/promotions/${codeDeal.id}`, { waitUntil: "networkidle" });
  await admin.screenshot({ path: `${SHOT_DIR}/admin-promotion-detail-desktop.png`, fullPage: true });

  // Pausing ends the deal for the next customer.
  await admin.getByRole("switch", { name: "Pause E2E 20% off $30+" }).click();
  check("pause switch stores isActive = false", await eventually(async () => !(await db.select().from(promotions).where(eq(promotions.id, codeDeal.id)))[0].isActive));
  const paused = await placeOrder({
    orderType: "pickup",
    customerName: "Late Larry",
    customerPhone: "5550109999",
    tipCents: 0,
    lines: [{ itemId: knots.id, quantity: 6, modifierIds: [] }],
    promoCodes: ["E2E-PIZZA"],
    expectedTotalCents: 3112,
  });
  check("a paused code says the offer has ended", !paused.ok && paused.error === "E2E-PIZZA: This offer has ended. Your total is now $38.91. Check it and place your order again.", paused.ok ? "placed" : paused.error);

  // With pickup off, a cart last left on pickup quotes delivery, as checkout will.
  await db.update(storeSettings).set({ pickupEnabled: false });
  try {
    const deliveryOnly = await browser.newPage({ viewport: { width: 375, height: 800 } });
    await deliveryOnly.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await cart(deliveryOnly, [knot(6)]);
    await deliveryOnly.evaluate(() => localStorage.setItem("minks-order-type-v1", "pickup"));
    await deliveryOnly.goto(`${BASE}/cart`, { waitUntil: "networkidle" });
    // 3594 + $3.99 fee − $3.99 free delivery + 8.25% tax (297) = 3891.
    check(
      "pickup off: the cart quotes delivery with the automatic deal",
      (await shows(deliveryOnly, "discount-line", "E2E Free delivery $30+")) && (await shows(deliveryOnly, "totals-total", "$38.91")),
      `${await textOf(deliveryOnly, "discount-line")} / ${await textOf(deliveryOnly, "totals-total")}`,
    );
    check("pickup off: the cart says only the tip is still to come", (await deliveryOnly.getByText("Tip is added at checkout.").count()) === 1);
    await deliveryOnly.screenshot({ path: `${SHOT_DIR}/cart-delivery-only-375.png`, fullPage: true });
    await deliveryOnly.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
    await deliveryOnly.getByRole("button", { name: "No tip" }).click();
    check(
      "pickup off: checkout quotes the same delivery total",
      await eventually(async () => (await deliveryOnly.getByTestId("place-order").innerText()).includes("Place delivery order · $38.91")),
      await deliveryOnly.getByTestId("place-order").innerText(),
    );
  } finally {
    await db.update(storeSettings).set({ pickupEnabled: true });
  }

  await browser.close();
  if (afterComp.ok) raceOrders.push(afterComp.orderId);
  await db.delete(orders).where(inArray(orders.id, raceOrders));
  await db.delete(operators).where(eq(operators.email, EMAIL));
  console.log(`\n${passes} passed, ${failures} failed. Screenshots in ${SHOT_DIR}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
