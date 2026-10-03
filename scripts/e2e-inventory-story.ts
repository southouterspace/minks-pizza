/**
 * The whole inventory story through the real UI, across the boundaries the
 * per-feature scripts stop at: an operator receives and counts stock, a
 * customer orders a Large Cheese Pizza with extra pepperoni on the left half,
 * the kitchen display takes it to handoff, recall reverses the sale and a
 * second handoff applies it once; an 86 threshold set in the ingredient
 * editor is crossed by the next sale, a delivery brings the items back, and
 * a short mozzarella count leads the variance report. Order status is only
 * ever changed by clicking the KDS. Removes everything it added.
 *
 * Run: E2E_BASE_URL=http://localhost:3100 NODE_PATH=scripts/shims npx tsx --env-file=.env.local scripts/e2e-inventory-story.ts
 * Mutates orders and the inventory ledger: point MINKS_DATABASE_URL at a test branch.
 */
import { mkdirSync } from "node:fs";
import bcrypt from "bcryptjs";
import { chromium, type Browser, type Page } from "playwright";
import { and, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
  db,
  ingredients,
  inventoryCounts,
  inventoryMoves,
  menuItems,
  modifierGroups,
  modifiers,
  operators,
  orderEvents,
  orderItems,
  orders,
  recipeLines,
  stockOuts,
  storeSettings,
} from "../src/db";
import { formatQty } from "../src/lib/units";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp/e2e-inventory-story";
const EMAIL = "story-e2e@minks.example";
const PASSWORD = "pizza-test-1234";
const MOZZ = "Whole-milk mozzarella";
const PEP = "Pepperoni";
const LARGE = 'Large 14"';
const LB = 453_592;
const OZ = 28_350;

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
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fn();
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

async function onHand(ingredientId: number): Promise<number> {
  const [row] = await db
    .select({ milli: sql<number>`coalesce(sum(${inventoryMoves.qtyMilli}), 0)`.mapWith(Number) })
    .from(inventoryMoves)
    .where(eq(inventoryMoves.ingredientId, ingredientId));
  return row.milli;
}

async function saleNet(orderId: string): Promise<Record<number, number>> {
  const rows = await db
    .select({
      ingredientId: inventoryMoves.ingredientId,
      milli: sql<number>`sum(${inventoryMoves.qtyMilli})`.mapWith(Number),
    })
    .from(inventoryMoves)
    .where(and(eq(inventoryMoves.orderId, orderId), eq(inventoryMoves.kind, "sale")))
    .groupBy(inventoryMoves.ingredientId);
  return Object.fromEntries(rows.filter((r) => r.milli !== 0).map((r) => [r.ingredientId, r.milli]));
}

const saleRowCount = async (orderId: string) =>
  (await db.select({ id: inventoryMoves.id }).from(inventoryMoves).where(eq(inventoryMoves.orderId, orderId))).length;

const sameUsage = (a: Record<number, number>, b: Record<number, number>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

async function orderRow(id: string) {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  return o;
}

async function signIn(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin$/);
  return page;
}

async function receive(page: Page, lines: { ingredient: string; qty: string; cost: string }[]) {
  await page.goto(`${BASE}/admin/inventory/receive`, { waitUntil: "networkidle" });
  await page.getByLabel("Vendor").fill("Story Foods");
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.getByRole("button", { name: "Add line" }).click();
    const row = page.getByTestId("delivery-line").nth(i);
    await row.locator("select").nth(0).selectOption({ label: line.ingredient });
    await row.getByLabel("Qty").fill(line.qty);
    await row.locator("select").nth(1).selectOption("lb");
    await row.getByLabel(/^\$ per/).fill(line.cost);
  }
  await page.getByRole("button", { name: "Save delivery" }).click();
  await page.getByTestId("delivery-saved").waitFor();
}

async function count(page: Page, lines: [name: string, milli: number][]) {
  await page.goto(`${BASE}/admin/inventory/count?kind=full`, { waitUntil: "networkidle" });
  for (const [name, milli] of lines) {
    await page.getByLabel(`${name} unit`, { exact: true }).selectOption("g");
    await page.getByLabel(`${name} quantity`, { exact: true }).fill((milli / 1000).toFixed(3));
  }
  await page.getByRole("button", { name: "Submit count" }).click();
  await page.waitForURL(/\/admin\/inventory\?notice=counted$/);
}

async function openPizza(page: Page) {
  await page.getByText("Cheese Pizza", { exact: true }).first().click();
  await page.waitForSelector('[role="dialog"]');
  await page.click(`label:has-text("${LARGE.slice(0, -1)}")`);
}

async function customerOrder(browser: Browser, tag: string): Promise<{ id: string; number: number }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await openPizza(page);
  const row = page.locator(`[data-topping="${PEP}"]`);
  await row.locator("label").click();
  await row.getByRole("radio", { name: "Left", exact: true }).click();
  await row.getByRole("radio", { name: "Extra", exact: true }).click();
  await page.getByRole("button", { name: /^Add \d+ to cart/ }).click();
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  await page.goto(`${BASE}/cart`, { waitUntil: "networkidle" });
  await page.click("text=Go to checkout");
  await page.waitForSelector("text=Order type");
  await page.fill("#co-name", `Story Customer ${tag}`);
  await page.fill("#co-phone", "(555) 010-7788");
  await page.fill("#co-email", "story@example.com");
  await page.click('button:has-text("Place pickup order")');
  await page.waitForURL(/\/order\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const id = page.url().split("/order/")[1].split(/[?#]/)[0];
  await page.waitForSelector("text=Order received");
  await shot(page, `order-${tag}`);
  await page.close();
  return { id, number: (await orderRow(id)).orderNumber };
}

const tab = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}\\s*\\d+$`) });

async function cook(kitchen: Page, order: { id: string; number: number }, tag: string) {
  const [pie] = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  const ticket = kitchen.getByTestId(`kds-ticket-${order.number}`);
  await tab(kitchen, "Make line").click();
  await ticket.waitFor({ timeout: 15_000 });
  await kitchen.getByTestId(`kds-item-${pie.id}`).click();
  await ticket.waitFor({ state: "detached", timeout: 5_000 });
  await tab(kitchen, "Oven").click();
  await ticket.waitFor();
  await kitchen.screenshot({ path: `${SHOT_DIR}/kds-oven-${tag}.png` });
  await kitchen.getByTestId(`kds-bump-${order.number}`).click();
  await ticket.waitFor({ state: "detached", timeout: 5_000 });
  await tab(kitchen, "Ready").click();
  const ready = kitchen.getByTestId(`kds-ready-${order.number}`);
  await ready.waitFor({ timeout: 10_000 });
  await kitchen.getByTestId(`kds-handoff-${order.number}`).click();
  await ready.waitFor({ state: "detached", timeout: 5_000 });
  return eventually(async () => (await orderRow(order.id)).status === "completed");
}

async function storefrontOffers(browser: Browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  const classic = (await page.getByText("Pepperoni Classic", { exact: true }).count()) > 0;
  await openPizza(page);
  const topping = (await page.locator(`[data-topping="${PEP}"]`).count()) > 0;
  await page.locator('[role="dialog"]').screenshot({ path: `${SHOT_DIR}/storefront-dialog-${classic ? "on" : "off"}.png` });
  await page.close();
  return { classic, topping };
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  await db.delete(operators).where(eq(operators.email, EMAIL));
  const [operator] = await db
    .insert(operators)
    .values({ email: EMAIL, name: "Story Tester", passwordHash: await bcrypt.hash(PASSWORD, 10) })
    .returning();

  const [settings] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
  const [mozz] = await db.select().from(ingredients).where(eq(ingredients.name, MOZZ));
  const [pep] = await db.select().from(ingredients).where(eq(ingredients.name, PEP));
  const [pepMod] = await db.select().from(modifiers).where(eq(modifiers.name, PEP));
  const [cheesePizza] = await db.select().from(menuItems).where(eq(menuItems.name, "Cheese Pizza"));
  const [sizeGroup] = await db.select().from(modifierGroups).where(eq(modifierGroups.role, "size"));
  const [large] = await db
    .select()
    .from(modifiers)
    .where(and(eq(modifiers.groupId, sizeGroup.id), eq(modifiers.name, LARGE)));
  const mozzStart = await onHand(mozz.id);
  const pepStart = await onHand(pep.id);
  const orderIds: string[] = [];
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });

  try {
    await db
      .update(storeSettings)
      .set({ isPublished: true, isAcceptingOrders: true, pickupEnabled: true })
      .where(eq(storeSettings.id, 1));
    if (pepMod.extraPriceDeltaCents === null) {
      await db.update(modifiers).set({ extraPriceDeltaCents: 300 }).where(eq(modifiers.id, pepMod.id));
    }

    const lines = await db
      .select()
      .from(recipeLines)
      .where(or(eq(recipeLines.menuItemId, cheesePizza.id), eq(recipeLines.modifierId, pepMod.id)));
    const resolved = (owner: (l: (typeof lines)[number]) => boolean) => {
      const out = new Map<number, number>();
      for (const l of lines.filter((l) => owner(l) && l.sizeModifierId === null)) out.set(l.ingredientId, l.qtyMilli);
      for (const l of lines.filter((l) => owner(l) && l.sizeModifierId === large.id)) out.set(l.ingredientId, l.qtyMilli);
      return out;
    };
    const pepFactor = (settings.halfPortionBps / 10_000) * (settings.extraPortionBps / 10_000);
    const expected: Record<number, number> = {};
    for (const [id, q] of resolved((l) => l.menuItemId === cheesePizza.id)) expected[id] = (expected[id] ?? 0) + q;
    for (const [id, q] of resolved((l) => l.modifierId === pepMod.id)) expected[id] = (expected[id] ?? 0) + q * pepFactor;
    for (const id of Object.keys(expected)) expected[Number(id)] = Math.round(expected[Number(id)]);
    const ingNames = new Map(
      (await db.select().from(ingredients).where(inArray(ingredients.id, Object.keys(expected).map(Number)))).map((i) => [i.id, i]),
    );
    console.log(
      `Expected usage per pie (half ${settings.halfPortionBps} bps × extra ${settings.extraPortionBps} bps on pepperoni):`,
      Object.entries(expected).map(([id, q]) => `${ingNames.get(Number(id))!.name} ${q} milli-${ingNames.get(Number(id))!.baseUnit}`).join(", "),
    );
    const expectedSale = Object.fromEntries(Object.entries(expected).map(([id, q]) => [id, -q]));
    check("expected pepperoni use is half × extra of the Large line", expected[pep.id] === Math.round(85_050 * pepFactor), String(expected[pep.id]));

    const admin = await signIn(browser);

    await receive(admin, [
      { ingredient: MOZZ, qty: "10", cost: "5.00" },
      { ingredient: PEP, qty: "4", cost: "5.50" },
    ]);
    await shot(admin, "1-received");
    await count(admin, [
      [MOZZ, 30 * LB],
      [PEP, 6 * LB],
    ]);
    const mozz0 = await onHand(mozz.id);
    const pep0 = await onHand(pep.id);
    check("count sets mozzarella and pepperoni on hand", mozz0 === 30 * LB && pep0 === 6 * LB, `${mozz0} ${pep0}`);
    await shot(admin, "1-counted");

    const first = await customerOrder(browser, "1");
    orderIds.push(first.id);
    const [line] = await db.select().from(orderItems).where(eq(orderItems.orderId, first.id));
    check(
      "order line carries pepperoni left half extra",
      line.modifiers.some((m) => m.kind === "placed" && m.modifierId === pepMod.id && m.placement === "left" && m.amount === "extra"),
      JSON.stringify(line.modifiers),
    );
    check("no sale moves before the order is completed", (await saleRowCount(first.id)) === 0);

    const kitchen = await admin.context().newPage();
    await kitchen.goto(`${BASE}/kitchen`, { waitUntil: "networkidle" });
    await kitchen.getByTestId("kds-start").click();
    check("KDS handoff completes the order", await cook(kitchen, first, "1"));

    check(
      "sale moves equal the recipe usage",
      await eventually(async () => sameUsage(await saleNet(first.id), expectedSale)),
      JSON.stringify(await saleNet(first.id)),
    );
    const unitCosts = new Map(
      (await db.select().from(ingredients).where(inArray(ingredients.id, Object.keys(expected).map(Number)))).map((i) => [
        i.id,
        i.unitCostMillicents,
      ]),
    );
    const expectedCost = Math.round(
      Object.entries(expected).reduce((sum, [id, q]) => sum + q * unitCosts.get(Number(id))!, 0) / 1_000_000,
    );
    const [costed] = await db.select().from(orderItems).where(eq(orderItems.id, line.id));
    check("order_items.cost_cents is the recipe cost", costed.costCents === expectedCost, `${costed.costCents} vs ${expectedCost}`);
    const mozz1 = await onHand(mozz.id);
    const pep1 = await onHand(pep.id);
    check(
      "on hand drops by exactly the usage",
      mozz0 - mozz1 === expected[mozz.id] && pep0 - pep1 === expected[pep.id],
      `${mozz0 - mozz1} ${pep0 - pep1}`,
    );
    await admin.goto(`${BASE}/admin/inventory`, { waitUntil: "networkidle" });
    const mozzRow = squash(await admin.getByTestId(`stock-row-${mozz.id}`).innerText());
    const pepRow = squash(await admin.getByTestId(`stock-row-${pep.id}`).innerText());
    check(
      "/admin/inventory shows the reduced on hand",
      mozzRow.includes(formatQty(mozz1, "g")) && pepRow.includes(formatQty(pep1, "g")),
      `${mozzRow} | ${pepRow} want ${formatQty(mozz1, "g")} ${formatQty(pep1, "g")}`,
    );
    await shot(admin, "4-overview-after-sale");

    await kitchen.keyboard.press("r");
    await kitchen.getByTestId(`kds-recall-${first.number}`).click();
    check("recall puts the order back to preparing", await eventually(async () => (await orderRow(first.id)).status === "preparing"));
    check(
      "recall nets the order's ledger to zero",
      await eventually(async () => Object.keys(await saleNet(first.id)).length === 0 && (await onHand(mozz.id)) === mozz0),
      JSON.stringify(await saleNet(first.id)),
    );
    check("second handoff completes the order", await cook(kitchen, first, "1b"));
    check(
      "second handoff applies usage once",
      await eventually(async () => sameUsage(await saleNet(first.id), expectedSale)) &&
        (await onHand(mozz.id)) === mozz1 &&
        (await onHand(pep.id)) === pep1,
      `${JSON.stringify(await saleNet(first.id))} rows=${await saleRowCount(first.id)}`,
    );
    check("ledger for the order is apply, reverse, apply", (await saleRowCount(first.id)) === 3 * Object.keys(expected).length, String(await saleRowCount(first.id)));

    const threshold = pep1 - 1_000;
    await admin.goto(`${BASE}/admin/inventory/ingredients/${pep.id}`, { waitUntil: "networkidle" });
    await admin.getByLabel("86 unit").selectOption("g");
    await admin.fill("#ing-out", (threshold / 1000).toFixed(3));
    await admin.getByRole("button", { name: "Save changes" }).click();
    await admin.waitForURL(/\/admin\/inventory\/ingredients\?saved=1$/);
    const [pepSaved] = await db.select().from(ingredients).where(eq(ingredients.id, pep.id));
    check("editor saves the 86 threshold", pepSaved.outAtMilli === threshold, String(pepSaved.outAtMilli));
    check("re-saving keeps pepperoni's unit cost", pepSaved.unitCostMillicents === unitCosts.get(pep.id), `${pepSaved.unitCostMillicents}`);
    check("not out yet above the threshold", (await db.select().from(stockOuts).where(eq(stockOuts.ingredientId, pep.id))).length === 0);
    const before86 = await storefrontOffers(browser);
    check("storefront offers pepperoni before the 86", before86.classic && before86.topping, JSON.stringify(before86));

    const second = await customerOrder(browser, "2");
    orderIds.push(second.id);
    check("second order handed off on the KDS", await cook(kitchen, second, "2"));
    check("sale crosses the threshold and 86's pepperoni", await eventually(async () => (await db.select().from(stockOuts).where(eq(stockOuts.ingredientId, pep.id))).length === 1));

    const using = await db
      .selectDistinct({ menuItemId: recipeLines.menuItemId, modifierId: recipeLines.modifierId })
      .from(recipeLines)
      .where(and(eq(recipeLines.ingredientId, pep.id), gt(recipeLines.qtyMilli, 0)));
    const itemNames = (await db.select().from(menuItems).where(inArray(menuItems.id, using.flatMap((u) => u.menuItemId ?? [])))).map((i) => i.name).sort();
    const modNames = (await db.select().from(modifiers).where(inArray(modifiers.id, using.flatMap((u) => u.modifierId ?? [])))).map((m) => m.name).sort();
    const eightySixed = [...itemNames, ...modNames].join(", ");
    await admin.goto(`${BASE}/admin/menu`, { waitUntil: "networkidle" });
    const red = (await admin.getByTestId("stock-out-banner").allInnerTexts()).map(squash);
    check("red banner names the 86'd items", red.includes(`${PEP} is out · 86'd ${eightySixed}`), JSON.stringify(red));
    await shot(admin, "6-banner");
    const notes = await db
      .select({ note: orderEvents.note })
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, second.id), isNotNull(orderEvents.note)));
    check(
      "the crossing order's history says what ran out",
      notes.some((n) => n.note === `${PEP} ran out · 86'd ${eightySixed}`),
      JSON.stringify(notes),
    );
    const after86 = await storefrontOffers(browser);
    check("storefront stops offering pepperoni", !after86.classic && !after86.topping, JSON.stringify(after86));

    await receive(admin, [{ ingredient: PEP, qty: "2", cost: "5.50" }]);
    check("delivery clears the stock-out", (await db.select().from(stockOuts).where(eq(stockOuts.ingredientId, pep.id))).length === 0);
    check(
      "red banner gone after the delivery",
      await eventually(async () => (await admin.getByTestId("stock-out-banner").count()) === 0, 5_000),
    );
    await shot(admin, "6-restocked");
    const restocked = await storefrontOffers(browser);
    check("storefront offers pepperoni again", restocked.classic && restocked.topping, JSON.stringify(restocked));

    const mozzNow = await onHand(mozz.id);
    const pepNow = await onHand(pep.id);
    await count(admin, [
      [MOZZ, mozzNow - 2 * OZ],
      [PEP, pepNow],
    ]);
    check("count posts the 2 oz short", (await onHand(mozz.id)) === mozzNow - 2 * OZ);
    await admin.goto(`${BASE}/admin/reports/variance`, { waitUntil: "networkidle" });
    const [latest] = await db
      .select()
      .from(inventoryCounts)
      .where(eq(inventoryCounts.operatorId, operator.id))
      .orderBy(sql`${inventoryCounts.id} desc`)
      .limit(1);
    check("variance opens on this count", (await admin.locator("#v-count").inputValue()) === String(latest.id));
    const firstRow = squash(await admin.getByTestId("variance-table").locator("tbody tr").first().innerText());
    check("mozzarella leads the variance report", firstRow.startsWith(MOZZ), firstRow);
    const cells = await admin.getByTestId(`variance-row-${mozz.id}`).locator("td").allInnerTexts();
    check("mozzarella variance is -2 oz", cells[7]?.trim() === "-2 oz", JSON.stringify(cells));
    const pepCells = await admin.getByTestId(`variance-row-${pep.id}`).locator("td").allInnerTexts();
    check("pepperoni variance is zero", pepCells[7]?.trim() === "0 oz", JSON.stringify(pepCells));
    await shot(admin, "7-variance");
  } finally {
    await browser.close();
    const outs = await db.select().from(stockOuts).where(eq(stockOuts.ingredientId, pep.id));
    for (const o of outs) {
      if (o.menuItemIds.length) await db.update(menuItems).set({ isAvailable: true }).where(inArray(menuItems.id, o.menuItemIds));
      if (o.modifierIds.length) await db.update(modifiers).set({ isAvailable: true }).where(inArray(modifiers.id, o.modifierIds));
    }
    await db.delete(stockOuts).where(eq(stockOuts.ingredientId, pep.id));
    if (orderIds.length) {
      await db.delete(inventoryMoves).where(inArray(inventoryMoves.orderId, orderIds));
      await db.delete(orders).where(inArray(orders.id, orderIds));
    }
    await db.delete(inventoryMoves).where(eq(inventoryMoves.operatorId, operator.id));
    await db.delete(inventoryCounts).where(eq(inventoryCounts.operatorId, operator.id));
    for (const ing of [mozz, pep]) {
      await db
        .update(ingredients)
        .set({ unitCostMillicents: ing.unitCostMillicents, outAtMilli: ing.outAtMilli, lowStockAtMilli: ing.lowStockAtMilli })
        .where(eq(ingredients.id, ing.id));
    }
    await db.update(modifiers).set({ extraPriceDeltaCents: pepMod.extraPriceDeltaCents }).where(eq(modifiers.id, pepMod.id));
    await db
      .update(storeSettings)
      .set({ isPublished: settings.isPublished, isAcceptingOrders: settings.isAcceptingOrders, pickupEnabled: settings.pickupEnabled })
      .where(eq(storeSettings.id, 1));
    await db.delete(operators).where(eq(operators.email, EMAIL));
    check(
      "cleanup restores on hand",
      (await onHand(mozz.id)) === mozzStart && (await onHand(pep.id)) === pepStart,
      `${await onHand(mozz.id)} ${await onHand(pep.id)} vs ${mozzStart} ${pepStart}`,
    );
  }

  console.log(failures === 0 ? `\nALL PASSED (${passes})` : `\n${failures} FAILED, ${passes} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await db.delete(operators).where(eq(operators.email, EMAIL)).catch(() => {});
  process.exit(1);
});
