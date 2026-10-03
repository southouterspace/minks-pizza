/**
 * Loyalty e2e against a running dev server and its database: the operator
 * turns the program on and configures it, a guest is enrolled at checkout,
 * completion posts points once (admin and KDS recall paths), a member signs
 * in with a texted code, redeems at checkout, gets points back on cancel,
 * loses a race for the same points, refers a friend, collects a birthday
 * bonus, is adjusted by the operator, and the balance audit holds at the end.
 *
 * Run: E2E_BASE_URL=http://localhost:3417 npx tsx --env-file=.env.local scripts/e2e-loyalty.ts
 * Wipes all loyalty data: point MINKS_DATABASE_URL at a test branch, never production.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import bcrypt from "bcryptjs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  loyaltyLedger,
  loyaltyMembers,
  loyaltyPromotions,
  loyaltyRewards,
  loyaltySettings,
  menuItems,
  modifierGroups,
  modifiers,
  operators,
  orders,
} from "../src/db";
import { localDate } from "../src/lib/loyalty";
import { INSUFFICIENT_POINTS, cancellationStatements, refreshMember } from "../src/lib/loyalty-server";
import { createOrder, OrderError } from "../src/lib/orders";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp/loyalty-shots";
const EMAIL = "loyalty-e2e@minks.example";
const PASSWORD = "pizza-test-1234";
const RITA = { name: "Rita Guest", phone: "(555) 010-3101", digits: "5550103101" };
const BEN = { name: "Ben Friend", phone: "555.010.3102", digits: "5550103102" };
const TZ = "America/Chicago";

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes++;
  else failures++;
}

async function eventually(fn: () => Promise<boolean>, ms = 8_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fn();
}

async function member(digits: string) {
  const [m] = await db.select().from(loyaltyMembers).where(eq(loyaltyMembers.phone, digits));
  return m;
}

function entries(memberId: number) {
  return db.select().from(loyaltyLedger).where(eq(loyaltyLedger.memberId, memberId));
}

async function orderRow(id: string) {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  return o;
}

const summary = (rows: { kind: string; points: number }[]) =>
  rows.map((r) => `${r.kind}:${r.points}`).sort().join(",");

async function resetLoyalty() {
  await db.execute(sql`delete from loyalty_ledger`);
  await db.execute(sql`delete from loyalty_login_codes`);
  await db.execute(sql`delete from loyalty_members`);
  await db.execute(sql`delete from loyalty_rewards`);
  await db.execute(sql`delete from loyalty_promotions`);
  await db.execute(sql`delete from loyalty_settings`);
  // Old tickets left on the line would crowd the admin inbox.
  await db.execute(sql`update orders set status = 'completed' where status in ('new','confirmed','preparing','ready')`);
  await db
    .insert(operators)
    .values({ email: EMAIL, name: "Loyalty E2E", passwordHash: await bcrypt.hash(PASSWORD, 4) })
    .onConflictDoNothing({ target: operators.email });
}

async function menu() {
  const items = await db.select().from(menuItems);
  const groups = await db.select().from(modifierGroups);
  const mods = await db.select().from(modifiers);
  const mod = (group: string, name: string) => {
    const g = groups.find((x) => x.name === group)!;
    return mods.find((m) => m.groupId === g.id && m.name === name)!;
  };
  const pizza = items.find((i) => i.name === "Pepperoni Classic")!;
  const large = mod("Size", 'Large 14"');
  const crust = mod("Crust", "Hand Tossed");
  // 1399 + 600 = 1999 cents.
  const cartLine = {
    key: `${pizza.id}:${[large.id, crust.id].sort((a, b) => a - b).join(",")}:`,
    itemId: pizza.id,
    itemName: pizza.name,
    unitPriceCents: pizza.basePriceCents + large.priceDeltaCents + crust.priceDeltaCents,
    quantity: 1,
    modifiers: [large, crust].map((m) => ({
      id: m.id,
      groupName: m.id === large.id ? "Size" : "Crust",
      modifierName: m.name,
      priceDeltaCents: m.priceDeltaCents,
    })),
  };
  const orderLines = [{ itemId: pizza.id, quantity: 1, modifierIds: [large.id, crust.id] }];
  return { cartLine, orderLines };
}

async function fillCart(page: Page, line: unknown) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate((l) => localStorage.setItem("minks-cart-v1", JSON.stringify([l])), line);
}

async function operatorSignIn(page: Page) {
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin$/);
}

/** Walks an order through the admin inbox buttons to completed. */
async function completeViaAdmin(page: Page, orderNumber: number, id: string) {
  const steps = [
    ["Confirm", "confirmed"],
    ["Start preparing", "preparing"],
    ["Mark ready", "ready"],
    ["Complete", "completed"],
  ] as const;
  for (const [label, status] of steps) {
    await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
    const card = page.getByTestId(`order-card-${orderNumber}`);
    await card.getByRole("button", { name: label, exact: true }).click();
    await eventually(async () => (await orderRow(id)).status === status);
  }
}

async function customerSignIn(page: Page, phone: string, name: string, path = "/rewards") {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Text me a code" }).click();
  const devCode = page.getByTestId("dev-code");
  await devCode.waitFor();
  const code = (await devCode.textContent())!.match(/\d{6}/)![0];
  await page.getByLabel("Code").fill(code);
  await page.getByLabel(/First name/).fill(name);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByTestId("points-balance").waitFor();
}

async function shots(ctx: BrowserContext, path: string, name: string, prep?: (p: Page) => Promise<void>) {
  for (const [suffix, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["mobile", { width: 375, height: 812 }],
  ] as const) {
    const page = await ctx.newPage();
    await page.setViewportSize(viewport);
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    if (prep) await prep(page);
    await page.screenshot({ path: `${SHOT_DIR}/${name}-${suffix}.png`, fullPage: true });
    await page.close();
  }
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  await resetLoyalty();
  const { cartLine, orderLines } = await menu();

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  });
  const opCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const op = await opCtx.newPage();
  await operatorSignIn(op);

  // --- Operator turns the program on and configures it ---------------------
  await op.goto(`${BASE}/admin/loyalty`, { waitUntil: "networkidle" });
  const toggle = async (name: string, enabled: boolean) => {
    await op.getByRole("switch", { name, exact: true }).click();
    await eventually(async () => (await db.select().from(loyaltySettings))[0]?.enabled === enabled);
    await op.waitForLoadState("networkidle");
  };
  await toggle("Turn on rewards program", true);
  check(
    "operator switch enables the program",
    await eventually(async () => (await db.select().from(loyaltySettings))[0]?.enabled === true),
  );
  const seeded = await db.select().from(loyaltyRewards);
  check(
    "enabling seeds the default reward ladder",
    seeded.map((r) => r.pointsCost).sort((a, b) => a - b).join(",") === "300,700,1500",
    seeded.map((r) => `${r.name}=${r.pointsCost}`).join(", "),
  );
  await toggle("Turn off rewards program", false);
  await toggle("Turn on rewards program", true);
  check("re-enabling does not duplicate rewards", (await db.select().from(loyaltyRewards)).length === 3);

  await op.goto(`${BASE}/admin/loyalty/settings`, { waitUntil: "networkidle" });
  await op.getByLabel("Birthday points").fill("750");
  await op.getByLabel("Tier 1 minimum points").fill("10");
  await op.getByRole("button", { name: "Save program settings" }).click();
  await op.getByTestId("form-error").waitFor();
  check(
    "settings reject a first tier above 0 points",
    (await op.getByTestId("form-error").textContent())?.includes("first tier must start at 0") === true,
  );
  await op.goto(`${BASE}/admin/loyalty/settings`, { waitUntil: "networkidle" });
  await op.getByLabel("Birthday points").fill("750");
  await op.getByRole("button", { name: "Save program settings" }).click();
  await op.waitForURL(/saved=1/);
  const [settingsRow] = await db.select().from(loyaltySettings);
  check("settings save the birthday points", settingsRow.birthdayPoints === 750, String(settingsRow.birthdayPoints));
  check(
    "default tiers are Regular 1x and Gold Crust 1.2x at 4000",
    JSON.stringify(settingsRow.tiers) ===
      JSON.stringify([
        { name: "Regular", minPoints: 0, multiplierBps: 10000 },
        { name: "Gold Crust", minPoints: 4000, multiplierBps: 12000 },
      ]),
    JSON.stringify(settingsRow.tiers),
  );

  await op.goto(`${BASE}/admin/loyalty/promotions`, { waitUntil: "networkidle" });
  const promoForm = op.getByTestId("promo-form-new");
  await promoForm.getByLabel("Name").fill("Last month's double points");
  await promoForm.getByLabel(/Starts/).fill("2026-01-01");
  await promoForm.getByLabel(/Ends/).fill("2026-01-31");
  await promoForm.getByRole("button", { name: "Add promotion" }).click();
  await op.waitForURL(/saved=1/);
  const [promo] = await db.select().from(loyaltyPromotions);
  check(
    "operator adds a dated 2x promotion",
    promo?.multiplierBps === 20000 && promo.startsOn === "2026-01-01" && promo.endsOn === "2026-01-31",
    JSON.stringify(promo),
  );

  // --- Guest checkout auto-enrolls by phone --------------------------------
  const ritaCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const rita = await ritaCtx.newPage();
  await fillCart(rita, cartLine);
  await rita.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
  const panel = rita.getByTestId("loyalty-panel");
  await panel.getByText("Earn 199 points on this order").waitFor();
  check("signed-out checkout previews 199 points (1999¢ × 10/$)", true);
  check(
    "join checkbox is checked by default",
    (await panel.getByRole("checkbox").getAttribute("aria-checked")) === "true",
  );
  await rita.locator("#co-name").fill(RITA.name);
  await rita.locator("#co-phone").fill(RITA.phone);
  await rita.getByRole("button", { name: "No tip" }).click();
  await rita.getByRole("button", { name: /^Place pickup order/ }).click();
  await rita.waitForURL(/\/order\//);
  const order1 = await orderRow(rita.url().split("/order/")[1]);
  await rita.getByText("You'll earn 199 points when your order is ready.").waitFor();
  check("order page promises the points", true);

  const r0 = await member(RITA.digits);
  check("guest checkout enrolls the phone", r0 !== undefined && r0.name === RITA.name);
  check(
    "order carries the member and promised points",
    order1.loyaltyMemberId === r0.id && order1.loyaltyPointsEarned === 199,
    `member ${order1.loyaltyMemberId}, earned ${order1.loyaltyPointsEarned}`,
  );
  check("nothing posts before the order completes", (await entries(r0.id)).length === 0 && r0.pointsBalance === 0);

  // --- Completion posts once ------------------------------------------------
  await completeViaAdmin(op, order1.orderNumber, order1.id);
  let rRows = await entries(r0.id);
  check(
    "admin completion posts the earn and the $15+ welcome bonus",
    summary(rRows) === "earn:199,signup_bonus:200",
    summary(rRows),
  );
  check("balance is 399", (await member(RITA.digits)).pointsBalance === 399);

  for (const action of [{ type: "recall" }, { type: "bump", view: "all" }, { type: "bump", view: "all" }]) {
    if ((await orderRow(order1.id)).status === "ready") break;
    await op.request.post(`${BASE}/api/kds`, { data: { ...action, orderId: order1.id } });
  }
  check("KDS recall + bump puts the order back to ready", (await orderRow(order1.id)).status === "ready");
  await op.request.post(`${BASE}/api/kds`, { data: { type: "handoff", orderId: order1.id } });
  check("KDS handoff completes it again", (await orderRow(order1.id)).status === "completed");
  rRows = await entries(r0.id);
  check("re-completing does not double-earn", summary(rRows) === "earn:199,signup_bonus:200", summary(rRows));

  await rita.reload({ waitUntil: "networkidle" });
  check("order page says the points were earned", await rita.getByText("You earned 199 points.").isVisible());

  // --- Sign in with a dev code; rewards page --------------------------------
  await customerSignIn(rita, RITA.phone, RITA.name);
  check("rewards page shows the balance", (await rita.getByTestId("points-balance").textContent())?.startsWith("399") === true);
  check("rewards page shows the tier", (await rita.getByTestId("member-tier").textContent()) === "Regular");
  const ladder = (await rita.getByTestId("reward-ladder").textContent()) ?? "";
  check(
    "ladder marks what's ready and what's left",
    ladder.includes("Ready to redeem at checkout") && ladder.includes("301 points to go") && ladder.includes("1,101 points to go"),
  );
  check("header shows the balance chip", (await rita.getByTestId("header-points").textContent()) === "399");
  check("expired promotion isn't shown", (await rita.getByTestId("active-promo").count()) === 0);
  check(
    "member is verified",
    (await member(RITA.digits)).verifiedAt !== null,
  );

  // --- Redeem at checkout ---------------------------------------------------
  await fillCart(rita, cartLine);
  await rita.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
  check("phone is prefilled from the member", (await rita.locator("#co-phone").inputValue()) === "(555) 010-3101");
  await rita.getByText("Free side").waitFor();
  check("rewards out of reach say how far", await rita.getByText("301 more points").isVisible() && await rita.getByText("1,101 more points").isVisible());
  await rita.getByText("$3 off", { exact: true }).click();
  await rita.getByTestId("discount-line").waitFor();
  await rita.getByRole("button", { name: "No tip" }).click();
  // 1999 − 300 = 1699; tax 8.25% of 1699 = 140; total 1839; earn 169.
  await eventually(async () => (await rita.getByTestId("order-total").textContent()) === "$18.39");
  check("checkout total is server-priced after the reward", (await rita.getByTestId("order-total").textContent()) === "$18.39");
  check("checkout shows points to earn on the net", (await rita.getByTestId("points-to-earn").textContent())?.includes("+169") === true);
  await shots(ritaCtx, "/checkout", "checkout-reward", async (p) => {
    await p.getByText("$3 off", { exact: true }).click();
    await p.getByTestId("discount-line").waitFor();
  });
  await rita.getByRole("button", { name: /^Place pickup order/ }).click();
  await rita.waitForURL(/\/order\//);
  const order2 = await orderRow(rita.url().split("/order/")[1]);
  check(
    "redeemed order stores discount, tax on the net, and total",
    order2.discountCents === 300 && order2.taxCents === 140 && order2.totalCents === 1839 &&
      order2.loyaltyPointsRedeemed === 300 && order2.loyaltyRewardName === "$3 off" && order2.loyaltyPointsEarned === 169,
    JSON.stringify({ d: order2.discountCents, t: order2.taxCents, total: order2.totalCents, e: order2.loyaltyPointsEarned }),
  );
  check("receipt shows the reward line", await rita.getByText("$3 off (300 pts)").isVisible());
  check("redemption debits 300", (await member(RITA.digits)).pointsBalance === 99);

  // --- Cancel refunds -------------------------------------------------------
  await op.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  const card2 = op.getByTestId(`order-card-${order2.orderNumber}`);
  await card2.getByRole("button", { name: "Cancel", exact: true }).click();
  await card2.getByRole("button", { name: "Confirm cancel" }).click();
  await eventually(async () => (await orderRow(order2.id)).status === "canceled");
  const afterCancel = await member(RITA.digits);
  check("cancel refunds the points", afterCancel.pointsBalance === 399, String(afterCancel.pointsBalance));
  check("refund doesn't count as lifetime earning", afterCancel.lifetimePoints === 399, String(afterCancel.lifetimePoints));

  // --- Concurrent double-redeem --------------------------------------------
  const threeOff = (await db.select().from(loyaltyRewards).where(eq(loyaltyRewards.pointsCost, 300)))[0];
  const racer = {
    orderType: "pickup" as const,
    customerName: RITA.name,
    customerPhone: RITA.phone,
    tipCents: 0,
    lines: orderLines,
    rewardId: threeOff.id,
  };
  const race = await Promise.allSettled([
    createOrder(racer, { memberId: afterCancel.id }),
    createOrder(racer, { memberId: afterCancel.id }),
  ]);
  const won = race.filter((r) => r.status === "fulfilled").length;
  const lost = race.filter(
    (r) => r.status === "rejected" && r.reason instanceof OrderError && r.reason.message === INSUFFICIENT_POINTS,
  ).length;
  check("two orders racing for 300 points: exactly one wins", won === 1 && lost === 1, `won ${won}, lost ${lost}`);
  check("loser sees the friendly message", lost === 1);
  check("399 − 300 leaves 99, never negative", (await member(RITA.digits)).pointsBalance === 99);
  const raceWinner = race.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>;
  await db.batch([
    db.update(orders).set({ status: "canceled" }).where(eq(orders.id, raceWinner.value.id)),
    ...cancellationStatements(raceWinner.value.id),
  ]);
  check("canceling the winner refunds it", (await member(RITA.digits)).pointsBalance === 399);

  // --- Referral -------------------------------------------------------------
  const ritaMember = await member(RITA.digits);
  await rita.goto(`${BASE}/rewards`, { waitUntil: "networkidle" });
  const link = (await rita.getByTestId("referral-link").textContent()) ?? "";
  check("rewards page shows the referral link", link.endsWith(`/rewards?ref=${ritaMember.referralCode}`), link);

  const benCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ben = await benCtx.newPage();
  await ben.goto(`${BASE}/rewards?ref=${ritaMember.referralCode}`, { waitUntil: "networkidle" });
  check("invite banner shows", await ben.getByTestId("referral-banner").isVisible());
  await customerSignIn(ben, BEN.phone, BEN.name, `/rewards?ref=${ritaMember.referralCode}`);
  const benMember = await member(BEN.digits);
  check("new member is linked to the referrer", benMember.referredById === ritaMember.id);
  check("no bonus before the first order", (await entries(benMember.id)).length === 0);

  const benOrder = await createOrder(
    { orderType: "pickup", customerName: BEN.name, customerPhone: BEN.phone, tipCents: 0, lines: orderLines },
    { memberId: benMember.id },
  );
  await completeViaAdmin(op, benOrder.orderNumber, benOrder.id);
  await refreshMember(benMember.id);
  await refreshMember(ritaMember.id);
  check(
    "friend gets earn + welcome + referee bonus once",
    summary(await entries(benMember.id)) === "earn:199,referral:300,signup_bonus:200",
    summary(await entries(benMember.id)),
  );
  const ritaReferral = (await entries(ritaMember.id)).filter((e) => e.kind === "referral");
  check("referrer gets 500 once", ritaReferral.length === 1 && ritaReferral[0].points === 500);

  // --- Birthday -------------------------------------------------------------
  const month = localDate(new Date(), TZ).month;
  await rita.goto(`${BASE}/rewards`, { waitUntil: "networkidle" });
  await rita.getByLabel("Birth month").selectOption(String(month));
  await rita.getByLabel("Birth day").selectOption("1");
  await rita.getByRole("button", { name: "Save" }).click();
  await rita.getByTestId("birthday").waitFor();
  check("birthday becomes read-only once set", await rita.getByText("Contact the store to change it.").isVisible());
  await rita.reload({ waitUntil: "networkidle" });
  check(
    "no birthday points for a birthday set this month",
    (await entries(ritaMember.id)).every((e) => e.kind !== "birthday"),
  );
  await db
    .update(loyaltyMembers)
    .set({ birthdaySetAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) })
    .where(eq(loyaltyMembers.id, ritaMember.id));
  await rita.reload({ waitUntil: "networkidle" });
  await rita.reload({ waitUntil: "networkidle" });
  const birthdays = (await entries(ritaMember.id)).filter((e) => e.kind === "birthday");
  check("birthday grant posts once", birthdays.length === 1 && birthdays[0].points === 750, JSON.stringify(birthdays.map((b) => b.points)));

  await fillCart(rita, cartLine);
  await rita.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
  await rita.getByText("Free side").waitFor();
  check(
    "an affordable free side still needs a side in the cart",
    await rita.getByText("Add a qualifying item to use this").isVisible(),
  );

  // --- Operator adjustment --------------------------------------------------
  await op.goto(`${BASE}/admin/loyalty/members?q=3101`, { waitUntil: "networkidle" });
  check("member search by phone digits finds one", (await op.getByTestId("member-row").count()) === 1);
  await op.getByRole("link", { name: RITA.name }).click();
  await op.waitForURL(/\/admin\/loyalty\/members\/\d+/);
  const before = (await member(RITA.digits)).pointsBalance;
  await op.getByLabel(/^Points/).fill("50");
  await op.getByLabel("Reason").fill("Late delivery");
  await op.getByRole("button", { name: "Adjust points" }).click();
  await op.waitForURL(/saved=adjusted/);
  const [adj] = await db
    .select()
    .from(loyaltyLedger)
    .where(and(eq(loyaltyLedger.memberId, ritaMember.id), eq(loyaltyLedger.note, "Late delivery")));
  const [opRow] = await db.select().from(operators).where(eq(operators.email, EMAIL));
  check("adjustment posts with the operator and reason", adj?.points === 50 && adj.operatorId === opRow.id);
  check("balance moves by 50", (await member(RITA.digits)).pointsBalance === before + 50);
  await op.getByLabel(/^Points/).fill("-100000");
  await op.getByLabel("Reason").fill("Oops");
  await op.getByRole("button", { name: "Adjust points" }).click();
  await op.getByTestId("form-error").waitFor();
  check(
    "below-zero adjustment is rejected with a friendly error",
    (await op.getByTestId("form-error").textContent()) === "That would take the balance below zero.",
  );
  check("balance unchanged after the rejection", (await member(RITA.digits)).pointsBalance === before + 50);

  // --- Expiry on inactivity -------------------------------------------------
  await db
    .update(loyaltyMembers)
    .set({ lastActivityAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) })
    .where(eq(loyaltyMembers.id, benMember.id));
  await refreshMember(benMember.id);
  await refreshMember(benMember.id);
  const expired = (await entries(benMember.id)).filter((e) => e.kind === "expire");
  check("13 months without an order expires the balance once", expired.length === 1 && expired[0].points === -699);
  check("expired member has 0 points", (await member(BEN.digits)).pointsBalance === 0);

  // --- Price protection ----------------------------------------------------
  await op.goto(`${BASE}/admin/loyalty/rewards`, { waitUntil: "networkidle" });
  const threeOffForm = op.getByTestId(`reward-form-${threeOff.id}`);
  await threeOffForm.getByLabel("Points").fill("400");
  check(
    "operator is told the old price holds before saving a raise",
    (await threeOffForm.getByTestId("price-note").textContent())?.startsWith("Customers keep paying 300 points for 60 days") === true,
  );
  await threeOffForm.getByRole("button", { name: "Save" }).click();
  await op.waitForURL(/saved=1/);
  const [raised] = await db.select().from(loyaltyRewards).where(eq(loyaltyRewards.id, threeOff.id));
  const protectedDays = (raised.priceProtectedUntil!.getTime() - Date.now()) / 86_400_000;
  check(
    "a raise keeps the old cost for 60 days",
    raised.pointsCost === 400 && raised.previousPointsCost === 300 && protectedDays > 59.9 && protectedDays <= 60,
    `${raised.pointsCost}/${raised.previousPointsCost}, ${protectedDays.toFixed(2)} days`,
  );
  await rita.goto(`${BASE}/rewards`, { waitUntil: "networkidle" });
  check(
    "customers see the scheduled increase",
    (await rita.getByTestId("price-increase").first().textContent())?.startsWith("Price going up to 400 on") === true,
  );
  const protectedOrder = await createOrder(racer, { memberId: ritaMember.id });
  check("redeeming during protection costs the old 300", protectedOrder.loyaltyPointsRedeemed === 300);
  await db.batch([
    db.update(orders).set({ status: "canceled" }).where(eq(orders.id, protectedOrder.id)),
    ...cancellationStatements(protectedOrder.id),
  ]);
  await op.goto(`${BASE}/admin/loyalty/rewards`, { waitUntil: "networkidle" });
  await threeOffForm.getByLabel("Points").fill("250");
  check("a cut is applied right away", (await threeOffForm.getByTestId("price-note").textContent()) === "Lower prices apply right away.");
  await threeOffForm.getByRole("button", { name: "Save" }).click();
  await op.waitForURL(/saved=1/);
  const [cut] = await db.select().from(loyaltyRewards).where(eq(loyaltyRewards.id, threeOff.id));
  check("a cut clears protection", cut.pointsCost === 250 && cut.previousPointsCost === null && cut.priceProtectedUntil === null);

  // --- Screenshots ----------------------------------------------------------
  const anonCtx = await browser.newContext();
  await shots(anonCtx, "/rewards", "rewards-signed-out");
  await shots(ritaCtx, "/rewards", "rewards-signed-in");
  await shots(opCtx, "/admin/loyalty", "admin-overview");
  await shots(opCtx, `/admin/loyalty/members/${ritaMember.id}`, "admin-member");
  await shots(opCtx, "/admin/loyalty/rewards", "admin-rewards");
  await shots(opCtx, "/admin/loyalty/settings", "admin-settings");
  await browser.close();

  // --- The balance invariant holds -----------------------------------------
  try {
    const out = execFileSync("npx", ["tsx", "--env-file=.env.local", "scripts/loyalty-audit.ts"], {
      encoding: "utf8",
    });
    check("loyalty-audit: balance = SUM(ledger) for every member", true, out.trim());
  } catch (err) {
    check("loyalty-audit: balance = SUM(ledger) for every member", false, String((err as { stdout?: string }).stdout));
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
