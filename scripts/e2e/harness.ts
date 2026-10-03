/**
 * Shared e2e and domain-test helpers: a real browser against a running dev
 * server, the same lib calls the app makes for setup the UI doesn't need to
 * drive, one `check` that compares against a literal, and the pass/fail
 * runner. Waits throw a named error, so a node:test scenario fails where it
 * stuck; `eventually` answers true/false for check-style scripts.
 */
import { mkdirSync } from "node:fs";
import bcrypt from "bcryptjs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { eq, ne } from "drizzle-orm";
import {
  db,
  loyaltyLedger,
  loyaltyMembers,
  menuItems,
  modifierGroups,
  modifiers,
  operators,
  orderItems,
  orders,
  storeSettings,
} from "../../src/db";
import { enrollVerifiedMember, ledgerKey, ledgerStatement } from "../../src/lib/loyalty-server";
import type { OrderStatus } from "../../src/lib/order-workflow";
import { folds, run as runStatements } from "../../src/lib/orders-server/folds";
import { mutateOrder, type OperatorContext } from "../../src/lib/orders-server/mutate";
import type { OrderMutation } from "../../src/lib/orders";

export const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
export const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp/e2e-shots";

let failures = 0;

/** Compared as JSON, so the expected literal reads the way a failure prints it. */
export function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

/** Runs a script's checks and exits 0 only if every one passed and nothing threw. */
export function run(main: () => Promise<void>): void {
  main().then(
    () => {
      console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
      process.exit(failures === 0 ? 0 : 1);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
}

/** Polls until `fn` holds or `ms` passes, then answers one last time. */
export async function eventually(fn: () => Promise<boolean>, ms = 6_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fn();
}

export async function waitUntil(check: () => Promise<boolean>, what: string, ms = 8_000): Promise<void> {
  if (!(await eventually(check, ms))) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
}

export type Account = { email: string; password: string; name: string };

/**
 * Opens `path` as an operator. The account is upserted first (its password
 * reset), so a run never depends on another script having created it or on
 * a fresh store's setup screen; an already signed-in page just lands.
 */
export async function signIn(page: Page, account: Account, path = "/admin"): Promise<void> {
  const passwordHash = await bcrypt.hash(account.password, 4);
  await db
    .insert(operators)
    .values({ email: account.email, name: account.name, passwordHash })
    .onConflictDoUpdate({ target: operators.email, set: { passwordHash, name: account.name } });
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  if (!page.url().includes("/admin/login")) return;
  await page.fill('input[name="email"]', account.email);
  await page.fill('input[name="password"]', account.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin$/, { timeout: 30_000 });
  if (path !== "/admin") await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
}

/** Menu item and modifier ids by name, as the seed names them. */
export async function menuLookup() {
  const [items, groups, mods] = await Promise.all([
    db.select().from(menuItems),
    db.select().from(modifierGroups),
    db.select().from(modifiers),
  ]);
  const found = <T>(what: string, row: T | undefined): T => {
    if (row === undefined) throw new Error(`${what} is not on the seeded menu`);
    return row;
  };
  const item = (name: string) => found(name, items.find((i) => i.name === name)).id;
  const pick = (group: string, name: string) => {
    const groupId = found(group, groups.find((g) => g.name === group)).id;
    return found(`${group}: ${name}`, mods.find((m) => m.groupId === groupId && m.name === name)).id;
  };
  return { item, pick };
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

const whole = (modifierId: number) => ({ modifierId, placement: "whole" as const, amount: "regular" as const });

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
    orderLines: [{ itemId: pizza.id, quantity: 1, notes: null, selections: [large.id, crust.id].map(whole) }],
    /** Below the delivery minimum. */
    knotsLines: [{ itemId: knots.id, quantity: 1, notes: null, selections: [] }],
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

/** The kitchen finishes the order, then the admin board's Complete button hands it off. */
export async function completeOnBoard(page: Page, order: { id: string; number: number }) {
  await moveOrder(order.id, "ready");
  await page.goto(`${BASE}/admin`);
  await page.getByTestId(`advance-${order.number}`).filter({ hasText: "Complete" }).click();
  await waitUntil(async () => (await orderRow(order.id)).status === "completed", `order #${order.number} to be completed`);
}

const ACTOR = { name: "E2E", operatorId: null, employeeId: null };

let operatorContext: OperatorContext | null = null;

/** The harness's own operator row, so its moves carry a real operator id on the audit rows. */
async function asOperator(): Promise<OperatorContext> {
  if (operatorContext) return operatorContext;
  const [row] = await db
    .insert(operators)
    .values({ email: "e2e-harness@minks.example", name: "E2E", passwordHash: "unused" })
    .onConflictDoUpdate({ target: operators.email, set: { name: "E2E" } })
    .returning({ id: operators.id });
  operatorContext = { operator: { id: row.id, name: "E2E" } };
  return operatorContext;
}

async function mutate(orderId: string, mutation: OrderMutation) {
  const result = await mutateOrder({ orderId, mutation }, await asOperator());
  if (!result.ok) throw new Error(`${mutation.kind} on ${orderId}: ${JSON.stringify(result)}`);
}

/**
 * Moves an order the way the store does: the kitchen's stamps drive the
 * fold up to ready, and a handoff completes it. Steps already passed are
 * no-ops, so "ready" from "new" works.
 */
export async function moveOrder(orderId: string, ...steps: Exclude<OrderStatus, "canceled" | "held">[]) {
  for (const to of steps) {
    switch (to) {
      case "new":
        await mutate(orderId, { kind: "fire", lineIds: "all" });
        break;
      case "preparing": {
        await mutate(orderId, { kind: "fire", lineIds: "all" });
        const [first] = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId)).limit(1);
        if (first) await db.update(orderItems).set({ ovenAt: new Date() }).where(eq(orderItems.id, first.id));
        await runStatements(await folds(orderId, ACTOR));
        break;
      }
      case "ready":
        await mutate(orderId, { kind: "fire", lineIds: "all" });
        await db.update(orderItems).set({ doneAt: new Date() }).where(eq(orderItems.orderId, orderId));
        await runStatements(await folds(orderId, ACTOR));
        break;
      case "completed":
        await mutate(orderId, { kind: "handoff" });
        break;
    }
    const row = await orderRow(orderId);
    if (row.status !== to) throw new Error(`moving ${orderId} to ${to} left it ${row.status}`);
  }
}

export async function cancelOrder(orderId: string) {
  await mutate(orderId, { kind: "cancel", reason: "Customer request" });
}

/** Takes every open order off the board so lane contents are predictable. */
export async function clearBoard() {
  const open = await db.select({ id: orders.id }).from(orders).where(ne(orders.status, "completed"));
  for (const o of open) {
    const row = await orderRow(o.id);
    if (row.status === "canceled") continue;
    await cancelOrder(o.id).catch(() => undefined);
  }
}

/** Full-page screenshots at desktop and 375px into SHOT_DIR (E2E_SHOT_DIR, or /tmp/e2e-shots). */
export async function shots(ctx: BrowserContext, path: string, name: string, prep?: (p: Page) => Promise<void>) {
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
