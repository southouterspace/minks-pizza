/**
 * Counts, waste and receiving e2e against a running dev server and its
 * database: two deliveries (the second flags a 12% price rise), a full count
 * with a reload mid-entry, the spot-count preset under both of its rules,
 * a waste entry, and an auto-86 driven by a count and undone by a delivery,
 * with the admin banner checked at each step. Asserts the screen and the
 * literal ledger rows.
 *
 * Run: NODE_PATH=scripts/shims npx tsx --env-file=.env.local scripts/e2e-inventory-ops.ts
 * Destructive: it wipes the inventory ledger, counts and stock-outs first.
 * Point MINKS_DATABASE_URL at a throwaway Neon branch, never production.
 */
import { mkdirSync } from "node:fs";
import bcrypt from "bcryptjs";
import { chromium, type Browser, type Page } from "playwright";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  db,
  ingredientPacks,
  ingredients,
  inventoryCounts,
  inventoryMoves,
  menuItems,
  modifiers,
  operators,
  stockOuts,
} from "../src/db";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp/e2e-inventory-ops";
const EMAIL = "inventory-e2e@minks.example";
const PASSWORD = "pizza-test-1234";
const LB = 453_592;
const MOZZ = "Whole-milk mozzarella";
const DRAFT_KEY = "minks:count-draft:full";

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

async function signIn(browser: Browser, width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin$/);
  return page;
}

const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function idOf(name: string): Promise<number> {
  const [row] = await db.select({ id: ingredients.id }).from(ingredients).where(eq(ingredients.name, name));
  return row.id;
}

async function movesAfter(lastId: number) {
  return db
    .select()
    .from(inventoryMoves)
    .where(gt(inventoryMoves.id, lastId))
    .orderBy(asc(inventoryMoves.id));
}

async function lastMoveId(): Promise<number> {
  const [row] = await db.select({ id: sql<number>`coalesce(max(${inventoryMoves.id}), 0)::int` }).from(inventoryMoves);
  return row.id;
}

async function unitCost(id: number): Promise<number> {
  const [row] = await db.select().from(ingredients).where(eq(ingredients.id, id));
  return row.unitCostMillicents;
}

async function resetInventory() {
  const outs = await db.select().from(stockOuts);
  const itemIds = outs.flatMap((o) => o.menuItemIds);
  const modIds = outs.flatMap((o) => o.modifierIds);
  if (itemIds.length) await db.update(menuItems).set({ isAvailable: true }).where(inArray(menuItems.id, itemIds));
  if (modIds.length) await db.update(modifiers).set({ isAvailable: true }).where(inArray(modifiers.id, modIds));
  await db.delete(stockOuts);
  await db.delete(inventoryMoves);
  await db.delete(inventoryCounts);
  await db.update(ingredients).set({ outAtMilli: null });
}

type DeliveryLine = { ingredient: string; qty: string; unit: string; cost: string };

async function receive(page: Page, vendor: string, lines: DeliveryLine[]) {
  await page.goto(`${BASE}/admin/inventory/receive`, { waitUntil: "networkidle" });
  await page.getByLabel("Vendor").fill(vendor);
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.getByRole("button", { name: "Add line" }).click();
    const row = page.getByTestId("delivery-line").nth(i);
    await row.locator("select").nth(0).selectOption({ label: line.ingredient });
    await row.getByLabel("Qty").fill(line.qty);
    await row.locator("select").nth(1).selectOption(line.unit);
    await row.getByLabel(/^\$ per/).fill(line.cost);
  }
  await page.getByRole("button", { name: "Save delivery" }).click();
  await page.getByTestId("delivery-saved").waitFor();
}

async function fillCount(page: Page, name: string, qty: string, unit?: string) {
  if (unit) await page.getByLabel(`${name} unit`, { exact: true }).selectOption(unit);
  await page.getByLabel(`${name} quantity`, { exact: true }).fill(qty);
}

async function submitCount(page: Page) {
  await page.getByRole("button", { name: "Submit count" }).click();
  await page.waitForURL(/\/admin\/inventory\?notice=counted$/);
}

const bannerText = async (page: Page, testId: string) =>
  (await page.getByTestId(testId).allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  await resetInventory();
  await db.delete(operators).where(eq(operators.email, EMAIL));
  await db
    .insert(operators)
    .values({ email: EMAIL, name: "Inventory Tester", passwordHash: await bcrypt.hash(PASSWORD, 10) });

  const mozz = await idOf(MOZZ);
  const pep = await idOf("Pepperoni");
  const dough = await idOf("Dough ball");
  await db.delete(ingredientPacks).where(eq(ingredientPacks.ingredientId, mozz));
  await db.insert(ingredientPacks).values({ ingredientId: mozz, name: "case", baseQtyMilli: 20 * LB });

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await signIn(browser, 1366);
  const phone = await signIn(browser, 375);

  await page.goto(`${BASE}/admin/inventory`, { waitUntil: "networkidle" });
  check("no banner when nothing is out or low", (await page.getByTestId("inventory-banner").count()) === 0);
  check(
    "fresh ingredient reads Not counted yet",
    (await page.getByTestId(`stock-row-${mozz}`).innerText()).includes("Not counted yet"),
  );

  let mark = await lastMoveId();
  await receive(page, "Sysco", [
    { ingredient: MOZZ, qty: "40", unit: "lb", cost: "4.00" },
    { ingredient: "Pepperoni", qty: "10", unit: "lb", cost: "5.50" },
  ]);
  let rows = await movesAfter(mark);
  check(
    "first delivery posts two receive moves at per-gram cost",
    JSON.stringify(rows.map((m) => [m.ingredientId, m.kind, m.qtyMilli, m.unitCostMillicents, m.vendor])) ===
      JSON.stringify([
        [mozz, "receive", 18_143_680, 882, "Sysco"],
        [pep, "receive", 4_535_920, 1213, "Sysco"],
      ]),
    JSON.stringify(rows.map((m) => [m.qtyMilli, m.unitCostMillicents])),
  );
  check("first delivery has no price warning", (await page.getByTestId("price-warning").count()) === 0);

  mark = await lastMoveId();
  await receive(phone, "Sysco", [
    { ingredient: MOZZ, qty: "40", unit: "lb", cost: "4.48" },
    { ingredient: "Pepperoni", qty: "10", unit: "lb", cost: "5.50" },
  ]);
  rows = await movesAfter(mark);
  check(
    "second delivery: mozzarella at 988 millicents/g, pepperoni unchanged",
    JSON.stringify(rows.map((m) => [m.ingredientId, m.qtyMilli, m.unitCostMillicents])) ===
      JSON.stringify([
        [mozz, 18_143_680, 988],
        [pep, 4_535_920, 1213],
      ]),
  );
  check("ingredient unit cost follows the latest delivery", (await unitCost(mozz)) === 988 && (await unitCost(pep)) === 1213);
  const warnings = await phone.getByTestId("price-warning").allInnerTexts();
  check(
    "price warning names only mozzarella",
    JSON.stringify(warnings.map((w) => w.trim())) === JSON.stringify([`${MOZZ} +12% vs last delivery`]),
    JSON.stringify(warnings),
  );
  check("receive page has no sideways scroll at 375px", await noSideScroll(phone));
  await phone.screenshot({ path: `${SHOT_DIR}/receive-warning-375.png`, fullPage: true });

  await page.goto(`${BASE}/admin/inventory/count?kind=full`, { waitUntil: "networkidle" });
  await fillCount(page, MOZZ, "3.75", "case");
  await page.getByTestId("draft-saved").waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("draft-saved").waitFor();
  check(
    "draft survives a reload",
    (await page.getByLabel(`${MOZZ} quantity`, { exact: true }).inputValue()) === "3.75" &&
      (await page.getByLabel(`${MOZZ} unit`, { exact: true }).inputValue()) === "case",
  );
  await fillCount(page, "Pepperoni", "18");
  await fillCount(page, "Dough ball", "100");
  await page.screenshot({ path: `${SHOT_DIR}/count-desktop.png`, fullPage: true });
  mark = await lastMoveId();
  await submitCount(page);
  rows = await movesAfter(mark);
  const [count] = await db.select().from(inventoryCounts).orderBy(sql`${inventoryCounts.id} desc`).limit(1);
  check(
    "count moves are counted minus on hand, one per counted line",
    JSON.stringify(
      rows
        .map((m) => [m.ingredientId, m.kind, m.qtyMilli, m.countId] as const)
        .sort((a, b) => a[0] - b[0]),
    ) ===
      JSON.stringify(
        [
          [dough, "count", 100_000, count.id],
          [mozz, "count", -2_267_960, count.id],
          [pep, "count", -907_184, count.id],
        ].sort((a, b) => Number(a[0]) - Number(b[0])),
      ),
    JSON.stringify(rows.map((m) => [m.ingredientId, m.qtyMilli])),
  );
  check("count row is a full count", count.kind === "full");
  check("draft cleared after submit", (await page.evaluate((k) => localStorage.getItem(k), DRAFT_KEY)) === null);
  check(
    "overview shows the counted quantity",
    (await page.getByTestId(`stock-row-${mozz}`).innerText()).includes("75 lb"),
  );
  await page.screenshot({ path: `${SHOT_DIR}/overview-desktop.png`, fullPage: true });

  await phone.goto(`${BASE}/admin/inventory/count?kind=full`, { waitUntil: "networkidle" });
  check("count sheet has no sideways scroll at 375px", await noSideScroll(phone));
  await phone.screenshot({ path: `${SHOT_DIR}/count-375.png`, fullPage: true });
  await phone.goto(`${BASE}/admin/inventory`, { waitUntil: "networkidle" });
  check("overview has no sideways scroll at 375px", await noSideScroll(phone));
  await phone.screenshot({ path: `${SHOT_DIR}/overview-375.png`, fullPage: true });

  await page.goto(`${BASE}/admin/inventory/count?kind=spot`, { waitUntil: "networkidle" });
  const spotNames = async () =>
    (await page.locator('[data-testid^="count-line-"] label').allInnerTexts()).map((t) => t.trim());
  const byValue = await spotNames();
  check(
    "spot count without sales: highest on-hand value first, rule shown",
    byValue.length === 5 &&
      [MOZZ, "Pepperoni", "Dough ball"].every((n) => byValue.includes(n)) &&
      (await page.getByTestId("count-rule").innerText()).includes("highest on-hand value"),
    JSON.stringify(byValue),
  );
  const sold: [string, number][] = [
    ["Bacon", 4 * LB],
    ["Ham", 3 * LB],
    ["Mushrooms", 5 * LB],
    ["Black olives", 2 * LB],
    ["Fresh basil", 1 * LB],
  ];
  for (const [name, qty] of sold) {
    const id = await idOf(name);
    await db.insert(inventoryMoves).values({ ingredientId: id, kind: "sale", qtyMilli: -qty, unitCostMillicents: await unitCost(id) });
  }
  await db.insert(inventoryMoves).values({
    ingredientId: await idOf("Grilled chicken"),
    kind: "sale",
    qtyMilli: -50 * LB,
    unitCostMillicents: 1102,
    createdAt: new Date(Date.now() - 8 * 86_400_000),
  });
  await page.reload({ waitUntil: "networkidle" });
  const byUsage = await spotNames();
  check(
    "spot count with sales: the five with the most dollar usage in 7 days, in shelf order",
    JSON.stringify(byUsage) === JSON.stringify(["Mushrooms", "Black olives", "Fresh basil", "Bacon", "Ham"]),
    JSON.stringify(byUsage),
  );
  check(
    "spot rule names the 7-day usage rule",
    (await page.getByTestId("count-rule").innerText()).includes("theoretical usage in dollars over the last 7 days"),
  );

  await page.goto(`${BASE}/admin/inventory/waste`, { waitUntil: "networkidle" });
  mark = await lastMoveId();
  await page.getByLabel("Ingredient").selectOption({ label: "Pepperoni" });
  await page.getByLabel("Quantity").fill("8");
  await page.getByLabel("Unit").selectOption("oz");
  await page.getByLabel("Reason").selectOption("burnt");
  await page.getByRole("button", { name: "Log waste" }).click();
  check(
    "waste posts a negative move with its reason",
    await eventually(async () => {
      const r = await movesAfter(mark);
      return (
        JSON.stringify(r.map((m) => [m.ingredientId, m.kind, m.qtyMilli, m.wasteReason, m.unitCostMillicents])) ===
        JSON.stringify([[pep, "waste", -226_800, "burnt", 1213]])
      );
    }),
  );
  const wasteRow = page.getByTestId("waste-row").first();
  await eventually(async () => (await wasteRow.count()) > 0);
  const wasteText = (await wasteRow.innerText()).replace(/\s+/g, " ");
  check("recent waste lists it with its dollar value", /8 oz Pepperoni.*Burnt.*\$2\.75/.test(wasteText), wasteText);

  await db.update(ingredients).set({ outAtMilli: 10 * LB }).where(eq(ingredients.id, mozz));
  await page.goto(`${BASE}/admin/inventory/count?kind=full`, { waitUntil: "networkidle" });
  await fillCount(page, MOZZ, "5");
  await fillCount(page, "Pepperoni", "3");
  await submitCount(page);
  const [out] = await db.select().from(stockOuts).where(eq(stockOuts.ingredientId, mozz));
  const offItems = await db
    .select({ name: menuItems.name })
    .from(menuItems)
    .where(and(eq(menuItems.isAvailable, false), inArray(menuItems.id, out?.menuItemIds ?? [-1])));
  check("counting below the 86 threshold creates the stock-out", out !== undefined && offItems.length === 6);
  await page.goto(`${BASE}/admin/menu`, { waitUntil: "networkidle" });
  const red = await bannerText(page, "stock-out-banner");
  check(
    "red banner on another admin page names what was 86'd",
    JSON.stringify(red) ===
      JSON.stringify([
        `${MOZZ} is out · 86'd BBQ Chicken, Cheese Pizza, Margherita, Meat Lovers, Pepperoni Classic, Veggie Supreme, Extra Cheese`,
      ]),
    JSON.stringify(red),
  );
  const amber = await bannerText(page, "low-stock-banner");
  check("amber banner lists low pepperoni only", JSON.stringify(amber) === JSON.stringify(["Running low · Pepperoni (3 lb)"]), JSON.stringify(amber));
  await page.screenshot({ path: `${SHOT_DIR}/banner-desktop.png` });
  await phone.goto(`${BASE}/admin/inventory`, { waitUntil: "networkidle" });
  check("banner has no sideways scroll at 375px", await noSideScroll(phone));
  await phone.screenshot({ path: `${SHOT_DIR}/banner-375.png`, fullPage: true });
  check(
    "overview badges mozzarella Out and pepperoni Low",
    (await phone.getByTestId(`stock-row-${mozz}`).innerText()).includes("Out") &&
      (await phone.getByTestId(`stock-row-${pep}`).innerText()).includes("Low"),
  );

  await receive(page, "Restaurant Depot", [{ ingredient: MOZZ, qty: "20", unit: "lb", cost: "5.00" }]);
  check(
    "a pricier delivery flags again",
    JSON.stringify((await page.getByTestId("price-warning").allInnerTexts()).map((w) => w.trim())) ===
      JSON.stringify([`${MOZZ} +12% vs last delivery`]),
  );
  await page.screenshot({ path: `${SHOT_DIR}/receive-warning-desktop.png`, fullPage: true });
  const [stillOut] = await db.select().from(stockOuts).where(eq(stockOuts.ingredientId, mozz));
  const backOn = await db
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(and(eq(menuItems.isAvailable, true), inArray(menuItems.id, out?.menuItemIds ?? [-1])));
  check("restock clears the stock-out and turns the items back on", stillOut === undefined && backOn.length === 6);
  check("red banner gone after restock", (await page.getByTestId("stock-out-banner").count()) === 0);

  await browser.close();
  await db.update(ingredients).set({ outAtMilli: null }).where(eq(ingredients.id, mozz));
  await db.delete(ingredientPacks).where(eq(ingredientPacks.ingredientId, mozz));
  await db.delete(operators).where(eq(operators.email, EMAIL));

  console.log(failures === 0 ? `\nALL PASSED (${passes})` : `\n${failures} FAILED, ${passes} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await db.delete(operators).where(eq(operators.email, EMAIL)).catch(() => {});
  process.exit(1);
});
