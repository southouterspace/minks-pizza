/**
 * Reports e2e against a running dev server and its database: today's orders
 * placed through checkout on the seeded menu and completed, a receive, a
 * waste and two counts; then each report and its CSV loaded as an operator,
 * the tabs, the range form, and the 375 px layout. Removes what it added.
 *
 * Run: NODE_PATH=scripts/shims E2E_BASE_URL=http://localhost:3104 npx tsx --env-file=.env.local scripts/e2e-reports.ts
 * Mutates orders and the inventory ledger: point MINKS_DATABASE_URL at a test branch.
 */
import { mkdirSync } from "node:fs";
import bcrypt from "bcryptjs";
import { chromium, request, type Browser, type Page } from "playwright";
import { eq, gt, inArray, sql } from "drizzle-orm";
import {
  db,
  ingredients,
  inventoryCounts,
  inventoryMoves,
  menuItems,
  modifierGroups,
  modifiers,
  operators,
  orders,
  storeSettings,
} from "../src/db";
import { onHand, recordMoves } from "../src/lib/inventory";
import { createOrder } from "../src/lib/orders";
import { transitionOrder } from "../src/lib/order-writes";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp/e2e-reports";
const EMAIL = "reports-e2e@minks.example";
const NAME = "Report Tester";
const PASSWORD = "pizza-test-1234";
const OZ = 28_350;
const LB = 453_592;

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes++;
  else failures++;
}

async function signIn(browser: Browser): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin$/);
  return page;
}

async function seededMenu() {
  const items = await db.select().from(menuItems);
  const groups = await db.select().from(modifierGroups);
  const mods = await db.select().from(modifiers);
  const ings = await db.select().from(ingredients);
  const item = (name: string) => items.find((i) => i.name === name)!.id;
  const pick = (group: string, name: string) =>
    mods.find((m) => m.groupId === groups.find((g) => g.name === group)!.id && m.name === name)!.id;
  const ingredient = (name: string) => ings.find((i) => i.name === name)!.id;
  return { item, pick, ingredient };
}

async function csv(page: Page, href: string) {
  const res = await page.request.get(`${BASE}${href}`);
  const body = await res.text();
  return {
    status: res.status(),
    type: res.headers()["content-type"] ?? "",
    disposition: res.headers()["content-disposition"] ?? "",
    lines: body.trimEnd().split("\r\n"),
  };
}

async function noPageScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const [settings] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
  await db.delete(operators).where(eq(operators.email, EMAIL));
  const [operator] = await db
    .insert(operators)
    .values({ email: EMAIL, name: NAME, passwordHash: await bcrypt.hash(PASSWORD, 10) })
    .returning();
  const actor = { name: operator.name, operatorId: operator.id };
  const [{ maxMove }] = await db
    .select({ maxMove: sql<number>`coalesce(max(${inventoryMoves.id}), 0)`.mapWith(Number) })
    .from(inventoryMoves);
  const orderIds: string[] = [];
  const countIds: number[] = [];

  try {
    await db
      .update(storeSettings)
      .set({ isPublished: true, isAcceptingOrders: true, pickupEnabled: true })
      .where(eq(storeSettings.id, 1));
    const { item, pick, ingredient } = await seededMenu();
    const mozz = ingredient("Whole-milk mozzarella");
    const pep = ingredient("Pepperoni");
    const dough = ingredient("Dough ball");

    async function count(kind: "full" | "spot", counted: (held: Map<number, number>) => [number, number][]) {
      const [row] = await db.insert(inventoryCounts).values({ kind, operatorId: operator.id }).returning();
      countIds.push(row.id);
      const held = await onHand([mozz, pep, dough]);
      await recordMoves(
        counted(held).map(([ingredientId, qty]) => ({
          ingredientId,
          kind: "count" as const,
          qtyMilli: qty - held.get(ingredientId)!,
          countId: row.id,
          operatorId: operator.id,
        })),
      );
    }

    await recordMoves([
      { ingredientId: mozz, kind: "receive", qtyMilli: 30 * LB, vendor: "E2E Foods" },
      { ingredientId: pep, kind: "receive", qtyMilli: 10 * LB, vendor: "E2E Foods" },
      { ingredientId: dough, kind: "receive", qtyMilli: 60_000, vendor: "E2E Foods" },
    ]);
    await count("full", (held) => [mozz, pep, dough].map((id) => [id, held.get(id)!]));

    const large = pick("Size", 'Large 14"');
    const small = pick("Size", 'Small 10"');
    const tossed = pick("Crust", "Hand Tossed");
    const carts = [
      [{ itemId: item("Cheese Pizza"), quantity: 2, modifiers: [{ id: large }, { id: tossed }, { id: pick("Extra Toppings", "Pepperoni") }, { id: pick("Extra Toppings", "Mushrooms"), placement: "left" as const }] }],
      [{ itemId: item("Pepperoni Classic"), quantity: 1, modifiers: [{ id: small }, { id: tossed }] }],
      [{ itemId: item("Cheese Pizza"), quantity: 1, modifiers: [{ id: small }, { id: tossed }, { id: pick("Extra Toppings", "Extra Cheese"), portion: "extra" as const }] }],
    ];
    for (const lines of carts) {
      const order = await createOrder({ orderType: "pickup", customerName: "Report E2E", customerPhone: "(555) 010-0200", tipCents: 0, lines });
      orderIds.push(order.id);
      for (const to of ["confirmed", "preparing", "ready", "completed"] as const) {
        await transitionOrder({ orderId: order.id, to, actor });
      }
    }
    await recordMoves([{ ingredientId: mozz, kind: "waste", qtyMilli: -8 * OZ, wasteReason: "dropped", operatorId: operator.id }]);
    await count("spot", (held) => [
      [mozz, held.get(mozz)! - 4 * OZ],
      [pep, held.get(pep)! - 1 * OZ],
    ]);

    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
    });
    const page = await signIn(browser);

    await page.goto(`${BASE}/admin/reports`, { waitUntil: "networkidle" });
    check("/admin/reports opens on food cost", page.url().endsWith("/admin/reports/food-cost"), page.url());
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: settings.timezone });
    await page.fill("#r-from", today);
    await page.fill("#r-to", today);
    await page.getByRole("button", { name: "Apply" }).click();
    await page.waitForURL(new RegExp(`from=${today}&to=${today}`));
    const todayRow = await page.getByTestId(`day-${today}`).innerText();
    check("food cost lists today's completed orders", /\b[3-9]\b|\d{2,}/.test(todayRow.split("\t")[1] ?? ""), todayRow.replace(/\s+/g, " "));
    check("food cost shows coverage", (await page.getByTestId("kpi-strip").innerText()).includes("Cost known for"));
    const foodHref = await page.getByTestId("export-csv").getAttribute("href");
    check("food cost CSV link reuses the range", foodHref === `/api/admin/reports/food-cost?from=${today}&to=${today}`, foodHref ?? "");
    const food = await csv(page, foodHref!);
    check("food cost CSV downloads", food.status === 200 && food.type.startsWith("text/csv") && food.disposition.includes(`food-cost-${today}-to-${today}.csv`), food.disposition);
    check("food cost CSV has a header, today and a total", food.lines[0] === "Day,Orders,Net sales,COGS,Food cost %,Cost known for % of sales" && food.lines[1].startsWith(`${today},`) && food.lines[2].startsWith("Total,"), food.lines.join(" | "));
    await page.screenshot({ path: `${SHOT_DIR}/food-cost-desktop.png`, fullPage: true });

    await page.getByRole("link", { name: "Variance", exact: true }).click();
    await page.waitForURL(/\/admin\/reports\/variance$/);
    check("variance tab is current", (await page.getByRole("link", { name: "Variance", exact: true }).getAttribute("aria-current")) === "page");
    const firstVariance = page.getByTestId("variance-table").locator("tbody tr").first();
    check("mozzarella leads the variance report", (await firstVariance.innerText()).includes("Whole-milk mozzarella"));
    check("mozzarella variance is the 4 oz short count", (await page.getByTestId(`variance-row-${mozz}`).innerText()).includes("-4 oz"));
    const variance = await csv(page, (await page.getByTestId("export-csv").getAttribute("href"))!);
    check("variance CSV has the latest count's two ingredients", variance.status === 200 && variance.lines.length === 3, variance.lines.join(" | "));
    check("variance CSV mozzarella line", /^Whole-milk mozzarella,g,[^,]+,[^,]+,[^,]+,226\.8,[^,]+,[^,]+,[^,]+,-113\.4,/.test(variance.lines[1]), variance.lines[1]);
    await page.screenshot({ path: `${SHOT_DIR}/variance-desktop.png`, fullPage: true });

    await page.getByRole("link", { name: "Topping mix", exact: true }).click();
    await page.waitForURL(/\/admin\/reports\/toppings$/);
    const largeMix = await page.getByTestId(`size-${large}`).innerText();
    check("topping mix shows Large pepperoni and mushrooms", largeMix.includes("Pepperoni") && largeMix.includes("Mushrooms"), largeMix.replace(/\s+/g, " ").slice(0, 160));
    const toppings = await csv(page, (await page.getByTestId("export-csv").getAttribute("href"))!);
    check("topping CSV header", toppings.lines[0] === "Size,Topping,Pizzas,With topping,Attach %,Half %,Light %,Extra %", toppings.lines[0]);
    await page.screenshot({ path: `${SHOT_DIR}/toppings-desktop.png`, fullPage: true });

    await page.getByRole("link", { name: "Margins", exact: true }).click();
    await page.waitForURL(/\/admin\/reports\/margins$/);
    const marginRows = await page.getByTestId("margin-table").locator("tbody tr").count();
    const margins = await csv(page, "/api/admin/reports/margins");
    check("margins CSV has one line per row on screen", margins.lines.length === marginRows + 1, `${margins.lines.length - 1} vs ${marginRows}`);
    check("margins lists Cheese Pizza Large", (await page.getByTestId(`margin-${item("Cheese Pizza")}-${large}`).innerText()).includes("Cheese Pizza"));
    await page.screenshot({ path: `${SHOT_DIR}/margins-desktop.png`, fullPage: true });

    const anon = await request.newContext();
    const unauth = await anon.get(`${BASE}/api/admin/reports/margins`);
    check("CSV refuses a signed-out request", unauth.status() === 401, String(unauth.status()));
    const unknown = await page.request.get(`${BASE}/api/admin/reports/nope`);
    check("unknown report is a 404", unknown.status() === 404, String(unknown.status()));
    await anon.dispose();

    await page.setViewportSize({ width: 375, height: 812 });
    for (const slug of ["food-cost", "variance", "toppings", "margins"]) {
      await page.goto(`${BASE}/admin/reports/${slug}`, { waitUntil: "networkidle" });
      check(`${slug} has no page scroll at 375px`, await noPageScroll(page));
      await page.screenshot({ path: `${SHOT_DIR}/${slug}-375.png`, fullPage: true });
    }
    const varianceScrolls = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="margin-table"]')!.parentElement!;
      return el.scrollWidth > el.clientWidth;
    });
    check("wide tables scroll inside their frame at 375px", varianceScrolls);

    await browser.close();
  } finally {
    await db.delete(inventoryMoves).where(gt(inventoryMoves.id, maxMove));
    if (countIds.length) await db.delete(inventoryCounts).where(inArray(inventoryCounts.id, countIds));
    if (orderIds.length) await db.delete(orders).where(inArray(orders.id, orderIds));
    await db
      .update(storeSettings)
      .set({ isPublished: settings.isPublished, isAcceptingOrders: settings.isAcceptingOrders, pickupEnabled: settings.pickupEnabled })
      .where(eq(storeSettings.id, 1));
    await db.delete(operators).where(eq(operators.email, EMAIL));
  }

  console.log(failures === 0 ? `\nALL PASSED (${passes})` : `\n${failures} FAILED, ${passes} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
