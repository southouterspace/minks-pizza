/**
 * Shared e2e helpers: a real browser against a running dev server, and the
 * same lib calls the app makes for setup the UI doesn't need to drive.
 * Waits throw a named error, so a node:test scenario fails where it stuck.
 */
import { mkdirSync } from "node:fs";
import bcrypt from "bcryptjs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { eq } from "drizzle-orm";
import { db, loyaltyLedger, loyaltyMembers, menuItems, modifierGroups, modifiers, operators, orders, storeSettings } from "../../src/db";
import { enrollVerifiedMember, ledgerKey, ledgerStatement } from "../../src/lib/loyalty-server";
import { transitionOrder } from "../../src/lib/order-writes";
import type { OrderStatus } from "../../src/lib/order-workflow";

export const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
export const SHOT_DIR = process.env.E2E_SHOT_DIR ?? null;

export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
}

export async function waitUntil(check: () => Promise<boolean>, what: string, ms = 8_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!(await check())) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
}

/** A phone no other run has used, so sign-in claims and lookups stay in this scenario. */
export function uniquePhone(): { digits: string; display: string } {
  const digits = `555${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
  return { digits, display: `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` };
}

export async function orderRow(id: string) {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  return o;
}

export async function memberByPhone(digits: string) {
  const [m] = await db.select().from(loyaltyMembers).where(eq(loyaltyMembers.phone, digits));
  return m;
}

export async function ledgerOf(memberId: number) {
  return db.select().from(loyaltyLedger).where(eq(loyaltyLedger.memberId, memberId));
}

/** "earn:199,signup_bonus:200": a member's ledger, order-independent. */
export const ledgerSummary = (rows: { kind: string; points: number }[]) =>
  rows.map((r) => `${r.kind}:${r.points}`).sort().join(",");

/** A verified member holding `points`, written through the ledger so the audit holds. */
export async function seedMember(points: number, name = "E2E Member") {
  const phone = uniquePhone();
  const member = await enrollVerifiedMember(phone.digits, { name, referredById: null });
  if (points > 0) {
    await ledgerStatement({ kind: "adjust", idemKey: ledgerKey.adjust(), from: { memberId: member.id, points }, note: "e2e seed" });
  }
  return { ...phone, id: member.id, name };
}

/** The pizza the scenarios order, priced at 1999¢, checked against the menu once. */
export async function menuFixture() {
  const [items, groups, mods, [store]] = await Promise.all([
    db.select().from(menuItems),
    db.select().from(modifierGroups),
    db.select().from(modifiers),
    db.select().from(storeSettings),
  ]);
  const mod = (group: string, name: string) => {
    const g = groups.find((x) => x.name === group);
    const m = g && mods.find((x) => x.groupId === g.id && x.name === name);
    if (!m) throw new Error(`Seed menu is missing ${group} → ${name}; run npm run db:seed`);
    return m;
  };
  const knots = items.find((i) => i.name === "Garlic Knots (6)");
  if (!knots) throw new Error("Seed menu is missing Garlic Knots (6); run npm run db:seed");
  const pizza = items.find((i) => i.name === "Pepperoni Classic");
  if (!pizza) throw new Error("Seed menu is missing Pepperoni Classic; run npm run db:seed");
  const large = mod("Size", 'Large 14"');
  const crust = mod("Crust", "Hand Tossed");
  const unitPriceCents = pizza.basePriceCents + large.priceDeltaCents + crust.priceDeltaCents;
  if (unitPriceCents !== 1999) throw new Error(`Expected a 1999¢ large pepperoni, got ${unitPriceCents}¢`);
  if (store.taxRateBps !== 825) throw new Error(`Expected 8.25% tax in store settings, got ${store.taxRateBps} bps`);
  if (!store.isPublished || !store.isAcceptingOrders || !store.pickupEnabled || !store.deliveryEnabled) {
    throw new Error("The store must be published and taking pickup and delivery orders");
  }
  if (knots.basePriceCents >= store.deliveryMinimumCents) {
    throw new Error("Garlic knots must cost less than the delivery minimum");
  }
  return {
    cartLine: {
      key: `${pizza.id}:${[large.id, crust.id].sort((a, b) => a - b).join(",")}:`,
      itemId: pizza.id,
      itemName: pizza.name,
      unitPriceCents,
      quantity: 1,
      modifiers: [
        { id: large.id, groupName: "Size", modifierName: large.name, priceDeltaCents: large.priceDeltaCents },
        { id: crust.id, groupName: "Crust", modifierName: crust.name, priceDeltaCents: crust.priceDeltaCents },
      ],
    },
    orderLines: [{ itemId: pizza.id, quantity: 1, modifierIds: [large.id, crust.id] }],
    /** Below the delivery minimum. */
    knotsLines: [{ itemId: knots.id, quantity: 1, modifierIds: [] }],
    timezone: store.timezone,
  };
}

export async function fillCart(page: Page, line: unknown) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate((l) => localStorage.setItem("minks-cart-v1", JSON.stringify([l])), line);
}

/** Upserts the password, so a changed password from an earlier run can't block sign-in. */
export async function signInOperator(page: Page, email: string, password = "pizza-test-1234") {
  const passwordHash = await bcrypt.hash(password, 4);
  await db
    .insert(operators)
    .values({ email, name: "E2E Operator", passwordHash })
    .onConflictDoUpdate({ target: operators.email, set: { passwordHash } });
  await page.goto(`${BASE}/admin/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin$/);
}

export async function signInCustomer(page: Page, phone: string, name: string, path = "/rewards") {
  await page.goto(`${BASE}${path}`);
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Text me a code" }).click();
  const devCode = page.getByTestId("dev-code");
  await devCode.waitFor();
  const code = (await devCode.textContent())?.match(/\d{6}/)?.[0];
  if (!code) throw new Error("The dev sign-in code didn't show; is this a dev server?");
  await page.getByLabel("Code").fill(code);
  await page.getByLabel(/First name/).fill(name);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByTestId("points-balance").waitFor();
}

/** Walks an order through the admin board's primary button to completed. */
export async function completeOnBoard(page: Page, order: { id: string; orderNumber: number }) {
  for (const [label, status] of [
    ["Confirm", "confirmed"],
    ["Start preparing", "preparing"],
    ["Mark ready", "ready"],
    ["Complete", "completed"],
  ] as const) {
    await page.goto(`${BASE}/admin`);
    await page.getByTestId(`advance-${order.orderNumber}`).filter({ hasText: label }).click();
    await waitUntil(async () => (await orderRow(order.id)).status === status, `order #${order.orderNumber} to be ${status}`);
  }
}

const ACTOR = { name: "E2E", operatorId: null };

/** Moves an order the way the admin board does, one legal step at a time. */
export async function moveOrder(orderId: string, ...steps: Exclude<OrderStatus, "canceled">[]) {
  for (const to of steps) {
    const result = await transitionOrder({ orderId, to, actor: ACTOR });
    if (!result.ok) throw new Error(`moving ${orderId} to ${to}: ${result.reason}`);
  }
}

export async function cancelOrder(orderId: string) {
  const result = await transitionOrder({ orderId, to: "canceled", actor: ACTOR, cancelReason: "Customer request" });
  if (!result.ok) throw new Error(`canceling ${orderId}: ${result.reason}`);
}

/** Full-page screenshots at desktop and 375px, when E2E_SHOT_DIR is set. */
export async function shots(ctx: BrowserContext, path: string, name: string, prep?: (p: Page) => Promise<void>) {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
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
