/**
 * Loyalty e2e: independent scenarios against a running dev server and its
 * database. Each scenario makes its own members (fresh phones) and orders;
 * the suite owns the program settings and the rewards named "E2E …", and
 * puts both back afterwards. The balance and lifetime audit runs last.
 *
 * Run: E2E_BASE_URL=http://localhost:3417 npm run e2e:loyalty
 * Writes to the database: point MINKS_DATABASE_URL at a test branch.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Browser, BrowserContext, Page } from "playwright";
import { and, eq, ilike, like } from "drizzle-orm";
import { categories, db, loyaltyLedger, loyaltyMembers, loyaltyRewards, loyaltySettings, operators } from "../../src/db";
import { DEFAULT_TIERS, INSUFFICIENT_POINTS, MONTHS, localYearMonth } from "../../src/lib/loyalty";
import { auditBalances, getMember, refreshMember } from "../../src/lib/loyalty-server";
import { createOrder } from "../../src/lib/checkout";
import {
  BASE,
  cancelOrder,
  completeOnBoard,
  fillCart,
  launchBrowser,
  ledgerOf,
  ledgerSummary,
  memberByPhone,
  menuFixture,
  moveOrder,
  orderRow,
  seedMember,
  shots,
  signInCustomer,
  signInOperator,
  uniquePhone,
  waitUntil,
} from "./harness";

const OPERATOR = "loyalty-e2e@minks.example";
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
const DAY_MS = 24 * 60 * 60 * 1000;

describe("loyalty", { timeout: 120_000 }, () => {
  let browser: Browser;
  let op: Page;
  let fixture: Awaited<ReturnType<typeof menuFixture>>;
  let threeOff: { id: number };
  let freeSide: { id: number };
  const contexts: BrowserContext[] = [];

  async function customer(): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    contexts.push(ctx);
    return ctx.newPage();
  }

  const order = (phone: string, name: string, extra: { rewardId?: number; joinLoyalty?: boolean } = {}) => ({
    orderType: "pickup" as const,
    customerName: name,
    customerPhone: phone,
    tipCents: 0,
    lines: fixture.orderLines,
    ...extra,
  });

  before(async () => {
    fixture = await menuFixture();
    await db
      .insert(loyaltySettings)
      .values({ id: 1, ...PROGRAM })
      .onConflictDoUpdate({ target: loyaltySettings.id, set: PROGRAM });
    await db.delete(loyaltyRewards).where(like(loyaltyRewards.name, "E2E %"));
    const sides = await db.select({ id: categories.id }).from(categories).where(ilike(categories.name, "%side%"));
    assert.ok(sides.length > 0, "the seed menu has a Sides category");
    [threeOff, freeSide] = await db
      .insert(loyaltyRewards)
      .values([
        { name: "E2E $3 off", pointsCost: 300, effect: { kind: "amount_off", amountOffCents: 300 } },
        {
          name: "E2E Free side",
          pointsCost: 650,
          effect: { kind: "free_item", categoryIds: sides.map((c) => c.id), maxValueCents: 999 },
        },
      ])
      .returning({ id: loyaltyRewards.id });
    browser = await launchBrowser();
    const opCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    contexts.push(opCtx);
    op = await opCtx.newPage();
    await signInOperator(op, OPERATOR);
  });

  after(async () => {
    await browser?.close();
    await db.delete(loyaltyRewards).where(like(loyaltyRewards.name, "E2E %"));
    await db.update(loyaltySettings).set(PROGRAM).where(eq(loyaltySettings.id, 1));
    const audit = await auditBalances();
    assert.deepEqual(audit.mismatches, [], "every balance and lifetime total matches the ledger");
  });

  it("the operator switch turns the program off and on without duplicating rewards", async () => {
    const before = (await db.select().from(loyaltyRewards)).length;
    await op.goto(`${BASE}/admin/loyalty`);
    const enabled = async () => (await db.select().from(loyaltySettings))[0].enabled;
    await op.getByRole("switch", { name: "Turn off rewards program", exact: true }).click();
    await waitUntil(async () => !(await enabled()), "the program to turn off");
    await op.getByRole("switch", { name: "Turn on rewards program", exact: true }).click();
    await waitUntil(enabled, "the program to turn back on");
    assert.equal((await db.select().from(loyaltyRewards)).length, before);
  });

  it("program settings refuse a first tier above 0 in the form and keep what was typed", async () => {
    await op.goto(`${BASE}/admin/loyalty/settings`);
    await op.getByLabel("Program name").fill("Mink's Points");
    await op.getByLabel("Tier 1 minimum points").fill("10");
    await op.getByRole("button", { name: "Save program settings" }).click();
    await op.getByTestId("form-error").waitFor();
    assert.equal(await op.getByTestId("form-error").textContent(), "The first tier must start at 0 points");
    assert.equal(await op.getByLabel("Program name").inputValue(), "Mink's Points");
    assert.equal((await db.select().from(loyaltySettings))[0].programName, "Mink's Rewards");

    await op.getByLabel("Tier 1 minimum points").fill("0");
    await op.getByLabel("Birthday points").fill("750");
    await op.getByRole("button", { name: "Save program settings" }).click();
    await op.getByTestId("form-notice").waitFor();
    const [saved] = await db.select().from(loyaltySettings);
    assert.deepEqual([saved.programName, saved.birthdayPoints], ["Mink's Points", 750]);
    await db.update(loyaltySettings).set(PROGRAM).where(eq(loyaltySettings.id, 1));
  });

  it("guest checkout enrolls the phone and completion posts the points once", async () => {
    const phone = uniquePhone();
    const page = await customer();
    await fillCart(page, fixture.cartLine);
    await page.goto(`${BASE}/cart`);
    await page.getByText("This order earns ~199 points").waitFor();

    await page.goto(`${BASE}/checkout`);
    const panel = page.getByTestId("loyalty-panel");
    await panel.getByText("Earn 199 points on this order").waitFor();
    assert.equal(await panel.getByRole("checkbox").getAttribute("aria-checked"), "true");
    await page.getByLabel("Name", { exact: true }).fill("Gail Guest");
    await page.getByLabel("Phone", { exact: true }).fill(phone.display);
    await page.getByRole("button", { name: "No tip" }).click();
    await page.getByRole("button", { name: /^Place pickup order/ }).click();
    await page.waitForURL(/\/order\//);
    await page.getByText("You'll earn 199 points once your order is complete.").waitFor();

    const placed = await orderRow(page.url().split("/order/")[1]);
    const member = await memberByPhone(phone.digits);
    assert.equal(member?.name, "Gail Guest");
    assert.deepEqual([placed.loyaltyMemberId, placed.loyaltyPointsEarned], [member.id, 199]);
    assert.deepEqual(await ledgerOf(member.id), []);

    await completeOnBoard(op, placed);
    assert.equal(ledgerSummary(await ledgerOf(member.id)), "earn:199,signup_bonus:200");
    assert.equal((await memberByPhone(phone.digits)).pointsBalance, 399);

    const recall = await op.request.post(`${BASE}/api/kds`, { data: { type: "recall", orderId: placed.id } });
    assert.equal(recall.status(), 200);
    assert.equal((await orderRow(placed.id)).status, "preparing");
    await moveOrder(placed.id, "ready");
    const handoff = await op.request.post(`${BASE}/api/kds`, { data: { type: "handoff", orderId: placed.id } });
    assert.equal(handoff.status(), 200);
    assert.equal((await orderRow(placed.id)).status, "completed");
    assert.equal(ledgerSummary(await ledgerOf(member.id)), "earn:199,signup_bonus:200", "re-completing doesn't double-earn");

    await page.reload();
    await page.getByText("You earned 199 points.").waitFor();
  });

  it("a refused guest order enrolls nobody", async () => {
    const phone = uniquePhone();
    await assert.rejects(
      createOrder({ ...order(phone.display, "Rae Refused", { joinLoyalty: true }), orderType: "delivery", lines: fixture.knotsLines }),
      { message: /^Delivery orders have a minimum subtotal of / },
    );
    await assert.rejects(createOrder(order(phone.display, "Rae Refused", { joinLoyalty: true, rewardId: threeOff.id })), {
      message: "Sign in to use your points.",
    });
    assert.equal(await memberByPhone(phone.digits), undefined);
  });

  it("a member sees their ladder, redeems at checkout, and a cancel gives the points back", async () => {
    const m = await seedMember(399, "Rita Redeemer");
    const page = await customer();
    await signInCustomer(page, m.display, m.name);
    assert.equal(await page.getByTestId("points-balance").textContent(), "399 points");
    assert.equal(await page.getByTestId("header-points").textContent(), "399");
    assert.equal(await page.getByTestId("member-tier").count(), 0, "one tier means no tier UI");
    const ladder = page.getByTestId("reward-ladder");
    const row = (id: number) => ladder.locator("li", { has: page.getByTestId(`reward-${id}`) });
    assert.match((await row(threeOff.id).textContent()) ?? "", /300 pts\$3 value.*Ready to redeem at checkout/);
    assert.match((await row(freeSide.id).textContent()) ?? "", /650 ptsup to \$9\.99 value.*251 points to go/);

    await fillCart(page, fixture.cartLine);
    await page.goto(`${BASE}/cart`);
    assert.equal(
      await page.getByTestId("cart-next-reward").textContent(),
      "After this order: 598 of 650 points toward E2E Free side.",
    );

    await page.goto(`${BASE}/checkout`);
    assert.equal(await page.getByLabel("Phone", { exact: true }).inputValue(), m.display);
    const option = (id: number) => page.getByTestId("loyalty-panel").getByTestId(`reward-${id}`);
    await option(freeSide.id).getByText("251 more points").waitFor();
    await option(threeOff.id).click();
    await page.getByRole("button", { name: "No tip" }).click();
    // 1999 − 300 = 1699; 8.25% tax on 1699 = 140; total 1839; earns 169.
    await waitUntil(async () => (await page.getByTestId("totals-total").textContent()) === "$18.39", "the server-priced total");
    assert.match((await page.getByTestId("points-to-earn").textContent()) ?? "", /\+169$/);
    await page.getByRole("button", { name: /^Place pickup order/ }).click();
    await page.waitForURL(/\/order\//);
    await page.getByTestId("discount-line").filter({ hasText: "E2E $3 off" }).getByText("Reward · 300 points").waitFor();

    const placed = await orderRow(page.url().split("/order/")[1]);
    assert.deepEqual(
      [placed.discountCents, placed.taxCents, placed.totalCents, placed.loyaltyPointsRedeemed, placed.loyaltyPointsEarned],
      [300, 140, 1839, 300, 169],
    );
    assert.equal((await memberByPhone(m.digits)).pointsBalance, 99);

    await op.goto(`${BASE}/admin`);
    await op.getByTestId(`cancel-${placed.orderNumber}`).click();
    const dialog = op.getByRole("dialog");
    await dialog.locator("select[name=reason]").selectOption("Customer request");
    await dialog.getByRole("button", { name: "Cancel order", exact: true }).click();
    await waitUntil(async () => (await orderRow(placed.id)).status === "canceled", "the cancel to land");
    const after = await memberByPhone(m.digits);
    assert.deepEqual([after.pointsBalance, after.lifetimePoints], [399, 399], "refunded, and not counted as earning");
  });

  it("two orders racing for the same points: exactly one wins", async () => {
    const m = await seedMember(399);
    const member = await getMember(m.id);
    const race = await Promise.allSettled([
      createOrder(order(m.display, m.name, { rewardId: threeOff.id }), member),
      createOrder(order(m.display, m.name, { rewardId: threeOff.id }), member),
    ]);
    const won = race.filter((r) => r.status === "fulfilled");
    const lost = race.filter((r) => r.status === "rejected");
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    assert.equal((lost[0] as PromiseRejectedResult).reason.message, INSUFFICIENT_POINTS);
    assert.equal((await memberByPhone(m.digits)).pointsBalance, 99);
    await cancelOrder((won[0] as PromiseFulfilledResult<{ id: string }>).value.id);
    assert.equal((await memberByPhone(m.digits)).pointsBalance, 399);
  });

  it("a referral pays both sides once, at the friend's first completed order", async () => {
    const referrer = await seedMember(0, "Rhea Referrer");
    const { referralCode } = (await getMember(referrer.id))!;
    const page = await customer();
    await signInCustomer(page, referrer.display, referrer.name);
    assert.ok((await page.getByTestId("referral-link").textContent())?.endsWith(`/rewards?ref=${referralCode}`));

    const friendPhone = uniquePhone();
    const friendPage = await customer();
    await friendPage.goto(`${BASE}/rewards?ref=${referralCode}`);
    await friendPage.getByTestId("referral-banner").waitFor();
    await signInCustomer(friendPage, friendPhone.display, "Finn Friend", `/rewards?ref=${referralCode}`);
    const friend = await memberByPhone(friendPhone.digits);
    assert.equal(friend.referredById, referrer.id);
    assert.deepEqual(await ledgerOf(friend.id), []);

    for (let i = 0; i < 2; i++) {
      const placed = await createOrder(order(friendPhone.display, "Finn Friend"), await getMember(friend.id));
      await moveOrder(placed.id, "confirmed", "preparing", "ready", "completed");
    }
    assert.equal(ledgerSummary(await ledgerOf(friend.id)), "earn:199,earn:199,referee_bonus:300,signup_bonus:200");
    assert.equal(ledgerSummary(await ledgerOf(referrer.id)), "referrer_bonus:500");
  });

  it("a birthday set this month waits a year; after 30 days the bonus posts once", async () => {
    const m = await seedMember(0, "Bea Birthday");
    const page = await customer();
    await signInCustomer(page, m.display, m.name);

    await page.getByLabel("Birth month").selectOption("2");
    await page.getByLabel("Birth day").selectOption("31");
    await page.getByRole("button", { name: "Save" }).click();
    assert.equal(await page.getByTestId("birthday-error").textContent(), "That date doesn't exist.");

    const now = new Date();
    const { month, year } = localYearMonth(now, fixture.timezone);
    await page.getByLabel("Birth month").selectOption(String(month));
    await page.getByLabel("Birth day").selectOption("1");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText("Contact the store to change it.").waitFor();
    // The bonus can't arrive until 30 days after setting it.
    const earliest = localYearMonth(new Date(now.getTime() + 30 * DAY_MS), fixture.timezone);
    const arrives = earliest.month === month ? year : year + 1;
    assert.equal(
      await page.getByTestId("birthday-arrival").textContent(),
      `Your 700 points arrive in ${MONTHS[month - 1]} ${arrives}, as long as you've ordered in the past year.`,
    );

    const placed = await createOrder(order(m.display, m.name), await getMember(m.id));
    await moveOrder(placed.id, "confirmed", "preparing", "ready", "completed");
    await db.update(loyaltyMembers).set({ birthdaySetAt: new Date(now.getTime() - 40 * DAY_MS) }).where(eq(loyaltyMembers.id, m.id));
    await page.reload();
    await page.reload();
    const birthdays = (await ledgerOf(m.id)).filter((e) => e.kind === "birthday");
    assert.deepEqual(birthdays.map((b) => b.points), [700]);
    assert.equal(await page.getByTestId("birthday-arrival").textContent(), "This year's 700 points have arrived. Happy birthday!");
  });

  it("an operator adjusts points with a reason, and can't take a balance below zero", async () => {
    const m = await seedMember(100, "Ada Adjusted");
    await op.goto(`${BASE}/admin/loyalty/members?q=${m.digits}`);
    await op.getByRole("link", { name: m.name }).click();
    await op.waitForURL(/\/admin\/loyalty\/members\/\d+/);
    const form = op.getByTestId("adjust-form");
    await form.getByLabel(/^Points/).fill("50");
    await form.getByLabel("Reason").fill("Late delivery");
    await form.getByRole("button", { name: "Adjust points" }).click();
    await form.getByTestId("form-notice").waitFor();
    const [operator] = await db.select().from(operators).where(eq(operators.email, OPERATOR));
    const [adjusted] = await db
      .select()
      .from(loyaltyLedger)
      .where(and(eq(loyaltyLedger.memberId, m.id), eq(loyaltyLedger.note, "Late delivery")));
    assert.deepEqual([adjusted.points, adjusted.operatorId], [50, operator.id]);

    await op.getByTestId("adjust-form").getByLabel(/^Points/).fill("-1000");
    await op.getByTestId("adjust-form").getByLabel("Reason").fill("Oops");
    await op.getByTestId("adjust-form").getByRole("button", { name: "Adjust points" }).click();
    const error = op.getByTestId("adjust-form").getByTestId("form-error");
    await error.waitFor();
    assert.equal(await error.textContent(), "That would take the balance below zero.");
    assert.equal(await op.getByTestId("adjust-form").getByLabel("Reason").inputValue(), "Oops");
    assert.equal((await memberByPhone(m.digits)).pointsBalance, 150);
  });

  it("13 idle months expire the balance once; a restore gives it back without counting as earning", async () => {
    const m = await seedMember(699, "Eve Expired");
    await db.update(loyaltyMembers).set({ lastActivityAt: new Date(Date.now() - 400 * DAY_MS) }).where(eq(loyaltyMembers.id, m.id));
    await refreshMember(m.id);
    await refreshMember(m.id);
    assert.deepEqual((await ledgerOf(m.id)).filter((e) => e.kind === "expire").map((e) => e.points), [-699]);
    assert.equal((await memberByPhone(m.digits)).pointsBalance, 0);

    await op.goto(`${BASE}/admin/loyalty/members/${m.id}`);
    await op.getByRole("button", { name: "Restore" }).click();
    await op.getByRole("button", { name: "Restore" }).waitFor({ state: "detached" });
    const restored = await memberByPhone(m.digits);
    assert.deepEqual([restored.pointsBalance, restored.lifetimePoints], [699, 699]);
    await refreshMember(m.id);
    assert.equal((await ledgerOf(m.id)).filter((e) => e.kind === "expire").length, 1, "restored points don't expire again at once");

    const page = await customer();
    await signInCustomer(page, m.display, m.name);
    const safeUntil = new Date(restored.lastActivityAt);
    safeUntil.setUTCMonth(safeUntil.getUTCMonth() + 12);
    const date = safeUntil.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: fixture.timezone });
    assert.equal(await page.getByTestId("safe-until").textContent(), `Your points are safe until ${date}. Any order resets the clock.`);
  });

  it("sign-in claims recent orders on the phone; the operator adds one by number, once", async () => {
    const phone = uniquePhone();
    const past = await createOrder(order(phone.display, "Cara Claimer"));
    await moveOrder(past.id, "confirmed", "preparing", "ready", "completed");
    assert.equal((await orderRow(past.id)).loyaltyMemberId, null);

    const page = await customer();
    await signInCustomer(page, phone.display, "Cara Claimer");
    const m = await memberByPhone(phone.digits);
    assert.equal((await orderRow(past.id)).loyaltyMemberId, m.id);
    assert.equal(ledgerSummary(await ledgerOf(m.id)), "earn:199,signup_bonus:200");
    assert.match((await page.getByTestId(`member-order-${past.orderNumber}`).textContent()) ?? "", /Posted/);

    const pending = await createOrder(order(phone.display, m.name!), await getMember(m.id));
    const canceled = await createOrder(order(phone.display, m.name!), await getMember(m.id));
    await cancelOrder(canceled.id);
    await page.reload();
    assert.match((await page.getByTestId(`member-order-${pending.orderNumber}`).textContent()) ?? "", /Pending/);
    assert.match((await page.getByTestId(`member-order-${canceled.orderNumber}`).textContent()) ?? "", /Reversed/);
    await cancelOrder(pending.id);

    const elsewhere = await createOrder(order(uniquePhone().display, m.name!));
    await moveOrder(elsewhere.id, "confirmed", "preparing", "ready", "completed");
    await op.goto(`${BASE}/admin/loyalty/members/${m.id}`);
    const form = op.getByTestId("claim-form");
    await form.getByLabel("Order number").fill(String(elsewhere.orderNumber));
    await form.getByRole("button", { name: "Add order" }).click();
    await form.getByTestId("form-notice").waitFor();
    assert.equal((await orderRow(elsewhere.id)).loyaltyMemberId, m.id);
    await form.getByLabel("Order number").fill(String(elsewhere.orderNumber));
    await form.getByRole("button", { name: "Add order" }).click();
    await form.getByTestId("form-error").waitFor();
    assert.equal(await form.getByTestId("form-error").textContent(), "That order already belongs to a member.");
  });

  it("the operator issues a birthday bonus once a year", async () => {
    const m = await seedMember(0, "Ivy Issued");
    await op.goto(`${BASE}/admin/loyalty/members/${m.id}`);
    const form = op.getByTestId("issue-birthday-form");
    await form.getByRole("button", { name: /^Issue birthday bonus/ }).click();
    await form.getByTestId("form-notice").waitFor();
    await form.getByRole("button", { name: /^Issue birthday bonus/ }).click();
    await form.getByTestId("form-error").waitFor();
    assert.equal(await form.getByTestId("form-error").textContent(), "This year's birthday bonus was already issued.");
    assert.deepEqual((await ledgerOf(m.id)).filter((e) => e.kind === "birthday").map((e) => e.points), [700]);
  });

  it("a raised reward price holds for 60 days; a cut applies at once", async () => {
    const [reward] = await db
      .insert(loyaltyRewards)
      .values({ name: "E2E Price watch", pointsCost: 200, effect: { kind: "amount_off", amountOffCents: 200 } })
      .returning();
    await op.goto(`${BASE}/admin/loyalty/rewards`);
    const form = op.getByTestId(`reward-form-${reward.id}`);
    await form.getByLabel("Points").fill("400");
    assert.match((await form.getByTestId("price-note").textContent()) ?? "", /^Customers keep paying 200 points for 60 days/);
    await form.getByRole("button", { name: "Save" }).click();
    await form.getByTestId("form-notice").waitFor();
    const [raised] = await db.select().from(loyaltyRewards).where(eq(loyaltyRewards.id, reward.id));
    const days = (raised.priceProtectedUntil!.getTime() - Date.now()) / DAY_MS;
    assert.deepEqual([raised.pointsCost, raised.previousPointsCost], [400, 200]);
    assert.ok(days > 59.9 && days <= 60, `${days} days of protection`);

    const m = await seedMember(250);
    const page = await customer();
    await signInCustomer(page, m.display, m.name);
    assert.match((await page.getByTestId(`reward-${reward.id}`).getByTestId("price-increase").textContent()) ?? "", /^Price going up to 400 on /);
    const placed = await createOrder(order(m.display, m.name, { rewardId: reward.id }), await getMember(m.id));
    assert.equal(placed.loyaltyPointsRedeemed, 200);
    await cancelOrder(placed.id);

    await op.goto(`${BASE}/admin/loyalty/rewards`);
    await form.getByLabel("Points").fill("150");
    assert.equal(await form.getByTestId("price-note").textContent(), "Lower prices apply right away.");
    await form.getByRole("button", { name: "Save" }).click();
    await form.getByTestId("form-notice").waitFor();
    const [cut] = await db.select().from(loyaltyRewards).where(eq(loyaltyRewards.id, reward.id));
    assert.deepEqual([cut.pointsCost, cut.previousPointsCost, cut.priceProtectedUntil], [150, null, null]);
  });

  it("a second tier turns the member's tier card on", async () => {
    await op.goto(`${BASE}/admin/loyalty/settings`);
    await op.getByLabel("Tier 2 name").fill("Gold Crust");
    await op.getByLabel("Tier 2 minimum points").fill("4000");
    await op.getByLabel("Tier 2 multiplier").fill("1.2");
    await op.getByRole("button", { name: "Save program settings" }).click();
    await op.getByTestId("form-notice").waitFor();
    assert.deepEqual((await db.select().from(loyaltySettings))[0].tiers, [
      { name: "Member", minPoints: 0, multiplierBps: 10_000 },
      { name: "Gold Crust", minPoints: 4000, multiplierBps: 12_000 },
    ]);
    const m = await seedMember(0);
    const page = await customer();
    await signInCustomer(page, m.display, m.name);
    assert.equal(await page.getByTestId("member-tier").textContent(), "Member");
    await db.update(loyaltySettings).set({ tiers: DEFAULT_TIERS }).where(eq(loyaltySettings.id, 1));
  });

  it("a member deletes their account: ledger gone, orders kept and unlinked", async () => {
    const m = await seedMember(0, "Del Deleter");
    const placed = await createOrder(order(m.display, m.name), await getMember(m.id));
    await moveOrder(placed.id, "confirmed", "preparing", "ready", "completed");
    const page = await customer();
    await signInCustomer(page, m.display, m.name);
    await page.getByRole("button", { name: "Delete my rewards account" }).click();
    await page.getByRole("button", { name: "Delete account" }).click();
    await page.getByText("Join or sign in").waitFor();
    assert.equal(await page.getByTestId("header-points").count(), 0);
    assert.equal(await memberByPhone(m.digits), undefined);
    assert.deepEqual(await ledgerOf(m.id), []);
    assert.equal((await orderRow(placed.id)).loyaltyMemberId, null);
  });

  it("screenshots for review (with E2E_SHOT_DIR)", async () => {
    const m = await seedMember(1699, "Sam Screens");
    const page = await customer();
    await signInCustomer(page, m.display, m.name);
    await fillCart(page, fixture.cartLine);
    const ctx = page.context();
    await shots(ctx, "/rewards", "rewards-signed-in");
    await shots(ctx, "/cart", "cart", (p) => p.getByTestId("cart-points").waitFor());
    await shots(ctx, "/checkout", "checkout-reward", async (p) => {
      await p.getByTestId("loyalty-panel").getByTestId(`reward-${threeOff.id}`).click();
      await p.getByTestId("discount-line").waitFor();
    });
    await shots(await browser.newContext(), "/rewards", "rewards-signed-out");
    await shots(op.context(), `/admin/loyalty/members/${m.id}`, "admin-member");
    await shots(op.context(), "/admin/loyalty/settings", "admin-settings");
    await shots(op.context(), "/admin/loyalty/rewards", "admin-rewards");
  });
});
