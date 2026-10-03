/**
 * Ingredients, recipes and topping settings e2e against a running dev server
 * and its database: create an ingredient with a case pack, edit Cheese
 * Pizza's recipe and read its plate cost, give a topping a per-size recipe
 * and an extra price, set group kinds and topping settings, the delete
 * guard, and a threshold change 86'ing the menu. Asserts both the screen and
 * what the database recorded.
 *
 * Run: NODE_PATH=scripts/shims E2E_BASE_URL=http://localhost:3102 npx tsx --env-file=.env.local scripts/e2e-recipes.ts
 * Mutates the menu and adds a temporary operator: point MINKS_DATABASE_URL at
 * a test branch, not production.
 */
import { mkdirSync } from "node:fs";
import bcrypt from "bcryptjs";
import { chromium, type Browser, type Page } from "playwright";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  ingredientPacks,
  ingredients,
  inventoryMoves,
  menuItems,
  modifierGroups,
  modifiers,
  operators,
  recipeLines,
  stockOuts,
  storeSettings,
} from "../src/db";
import { recordMoves, syncStockOuts } from "../src/lib/inventory";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp/e2e-recipes";
const EMAIL = "recipes-e2e@minks.example";
const PASSWORD = "pizza-test-1234";
const PROVOLONE = "E2E Provolone";
const REMOVALS = "E2E Removals";
const VENDOR = "e2e-recipes";

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

async function shoot(desktop: Page, phone: Page, path: string, name: string) {
  for (const [page, suffix] of [[desktop, "desktop"], [phone, "375"]] as const) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${SHOT_DIR}/${name}-${suffix}.png`, fullPage: true });
  }
  const overflow = await phone.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(`${name}: no sideways scroll at 375 px`, overflow <= 0, `overflow ${overflow}px`);
}

const ingredientByName = async (name: string) =>
  (await db.select().from(ingredients).where(eq(ingredients.name, name)))[0];

const SETTINGS_DEFAULTS = {
  halfToppingPriceBps: 5000,
  halfPortionBps: 5000,
  lightPortionBps: 5000,
  extraPortionBps: 15000,
  minMarginBps: 7000,
};

async function cleanup() {
  const old = await ingredientByName(PROVOLONE);
  if (old) await db.delete(ingredients).where(eq(ingredients.id, old.id));
  await db.delete(operators).where(eq(operators.email, EMAIL));
  await db.delete(modifierGroups).where(eq(modifierGroups.name, REMOVALS));
  await db.delete(inventoryMoves).where(eq(inventoryMoves.vendor, VENDOR));
  await db.update(storeSettings).set(SETTINGS_DEFAULTS).where(eq(storeSettings.id, 1));
  const pepperoni = await ingredientByName("Pepperoni");
  if (pepperoni) await db.update(ingredients).set({ outAtMilli: null }).where(eq(ingredients.id, pepperoni.id));
  await syncStockOuts();
}

async function ids() {
  const groups = await db.select().from(modifierGroups);
  const mods = await db.select().from(modifiers);
  const items = await db.select().from(menuItems);
  const group = (name: string) => groups.find((g) => g.name === name)!.id;
  return {
    group,
    mod: (groupName: string, name: string) =>
      mods.find((m) => m.groupId === group(groupName) && m.name === name)!.id,
    item: (name: string) => items.find((i) => i.name === name)!.id,
  };
}

async function setGroupKind(page: Page, groupId: number, kind: string) {
  await page.locator(`details:has(#group-${groupId}-kind) > summary`).click();
  await page.selectOption(`#group-${groupId}-kind`, kind);
  await page.locator(`form:has(#group-${groupId}-kind) button[type="submit"]`).click();
}

async function groupKindsFlow(page: Page) {
  await db.update(modifierGroups).set({ kind: "choice" });
  const { group } = await ids();
  await page.goto(`${BASE}/admin/modifiers`, { waitUntil: "networkidle" });
  await setGroupKind(page, group("Size"), "size");
  await page.waitForLoadState("networkidle");
  await setGroupKind(page, group("Extra Toppings"), "toppings");
  const kinds = async () =>
    Object.fromEntries((await db.select().from(modifierGroups)).map((g) => [g.name, g.kind]));
  check(
    "group kinds saved: Size = size, Extra Toppings = toppings, Crust = choice",
    await eventually(async () => {
      const k = await kinds();
      return k["Size"] === "size" && k["Extra Toppings"] === "toppings" && k["Crust"] === "choice";
    }),
    JSON.stringify(await kinds()),
  );
  await page.goto(`${BASE}/admin/modifiers`, { waitUntil: "networkidle" });
  check("kind badge shows Toppings", (await page.getByTestId(`group-kind-${group("Extra Toppings")}`).innerText()) === "Toppings");
}

async function toppingFlow(page: Page, phone: Page) {
  const { mod } = await ids();
  const mushrooms = mod("Extra Toppings", "Mushrooms");
  const [small, medium, large, xl] = ['Small 10"', 'Medium 12"', 'Large 14"', 'X-Large 16"'].map((n) => mod("Size", n));
  await page.goto(`${BASE}/admin/modifiers`, { waitUntil: "networkidle" });

  await page.locator(`details:has(#mod-extra-${mushrooms}) > summary`).click();
  await page.fill(`#mod-extra-${mushrooms}`, "2.75");
  await page.locator(`form:has(#mod-extra-${mushrooms}) button[type="submit"]`).click();
  check(
    "Mushrooms extra price stored as 275 cents",
    await eventually(async () => (await db.select().from(modifiers).where(eq(modifiers.id, mushrooms)))[0].extraPriceDeltaCents === 275),
  );
  const row = page.locator(`li:has(#mod-extra-${mushrooms})`);
  check("extra price shown on the row", await eventually(async () => (await row.innerText()).includes("extra +$2.75")), await row.innerText());

  await page.locator(`[data-testid="recipe-toggle-${mushrooms}"] > summary`).click();
  const editor = page.getByTestId(`recipe-modifier-${mushrooms}`);
  check("topping recipe shows a column per size plus All sizes", (await editor.locator("thead").innerText()).includes("All sizes") && (await editor.locator("thead").innerText()).includes('X-Large 16"'));
  await editor.getByLabel("Mushrooms All sizes").fill("1.5");
  await editor.getByLabel('Mushrooms Small 10"').fill("");
  await editor.getByLabel('Mushrooms Medium 12"').fill("");
  await editor.getByLabel('Mushrooms Large 14"').fill("2.5");
  await editor.getByLabel('Mushrooms X-Large 16"').fill("3");
  await editor.getByRole("button", { name: "Save recipe" }).click();
  const lines = async () =>
    (await db.select().from(recipeLines).where(eq(recipeLines.modifierId, mushrooms)))
      .map((l) => `${l.sizeModifierId ?? "all"}=${l.qtyMilli}`)
      .sort()
      .join(",");
  const expected = [`${large}=70875`, `${xl}=85050`, "all=42525"].sort().join(",");
  check("Mushrooms per-size recipe stored in milli grams", await eventually(async () => (await lines()) === expected), `${await lines()} vs ${expected}`);
  check("cleared sizes fall back to All sizes (no Small/Medium lines)", !(await lines()).includes(`${small}=`) && !(await lines()).includes(`${medium}=`));

  for (const [p, suffix] of [[page, "desktop"], [phone, "375"]] as const) {
    await p.goto(`${BASE}/admin/modifiers`, { waitUntil: "networkidle" });
    await p.locator(`[data-testid="recipe-toggle-${mushrooms}"] > summary`).click();
    await p.getByTestId(`recipe-modifier-${mushrooms}`).scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${SHOT_DIR}/modifiers-${suffix}.png`, fullPage: true });
  }
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("modifiers: no sideways scroll at 375 px", overflow <= 0, `overflow ${overflow}px`);
}

async function removalFlow(page: Page) {
  await page.goto(`${BASE}/admin/modifiers`, { waitUntil: "networkidle" });
  await page.getByText("+ New group").click();
  await page.fill("#new-group-name", REMOVALS);
  await page.getByRole("button", { name: "Add group" }).click();
  const groupId = await (async () => {
    await eventually(async () => (await db.select().from(modifierGroups).where(eq(modifierGroups.name, REMOVALS))).length === 1);
    return (await db.select().from(modifierGroups).where(eq(modifierGroups.name, REMOVALS)))[0].id;
  })();
  await page.waitForLoadState("networkidle");
  await page.locator(`details:has(#add-mod-name-${groupId}) > summary`).click();
  await page.fill(`#add-mod-name-${groupId}`, "No onions");
  await page.locator(`form:has(#add-mod-name-${groupId}) button[type="submit"]`).click();
  await eventually(async () => (await db.select().from(modifiers).where(eq(modifiers.groupId, groupId))).length === 1);
  const [noOnions] = await db.select().from(modifiers).where(eq(modifiers.groupId, groupId));
  await page.goto(`${BASE}/admin/modifiers`, { waitUntil: "networkidle" });

  await page.locator(`[data-testid="recipe-toggle-${noOnions.id}"] > summary`).click();
  const editor = page.getByTestId(`recipe-modifier-${noOnions.id}`);
  await editor.getByLabel("Ingredient to add").selectOption({ label: "Red onions" });
  await editor.getByRole("button", { name: "Add ingredient" }).click();
  await editor.getByLabel("Red onions All sizes").fill("-1");
  check("a negative quantity reads as removes", (await editor.innerText()).includes("removes 1 oz"));
  await editor.getByRole("button", { name: "Save recipe" }).click();
  const onions = (await ingredientByName("Red onions")).id;
  check(
    "No onions stores −1 oz of red onions at all sizes",
    await eventually(async () => {
      const l = await db.select().from(recipeLines).where(eq(recipeLines.modifierId, noOnions.id));
      return l.length === 1 && l[0].ingredientId === onions && l[0].qtyMilli === -28_350 && l[0].sizeModifierId === null;
    }),
  );
}

async function itemRecipeFlow(page: Page, phone: Page) {
  const { item, mod } = await ids();
  const cheese = item("Cheese Pizza");
  const large = mod("Size", 'Large 14"');
  const mozz = (await ingredientByName("Whole-milk mozzarella")).id;
  const largeMozz = and(eq(recipeLines.menuItemId, cheese), eq(recipeLines.sizeModifierId, large), eq(recipeLines.ingredientId, mozz));
  await db.update(recipeLines).set({ qtyMilli: 170_100 }).where(largeMozz);
  // The plate-cost literals below assume seeded prices; other e2e scripts post deliveries that move them.
  for (const [name, unitCostMillicents] of [["Dough ball", 60_000], ["Pizza sauce", 265], ["Whole-milk mozzarella", 882]] as const) {
    await db.update(ingredients).set({ unitCostMillicents }).where(eq(ingredients.name, name));
  }

  await page.goto(`${BASE}/admin/menu/items/${cheese}`, { waitUntil: "networkidle" });
  const cell = page.getByLabel('Whole-milk mozzarella Large 14"');
  check("grid shows Large mozzarella as 6 oz", (await cell.inputValue()) === "6" && (await page.getByLabel("Whole-milk mozzarella unit").inputValue()) === "oz");
  const plate = page.getByTestId(`plate-${large}`);
  check("Large plate at 6 oz mozzarella costs $2.48", (await plate.innerText()).includes("Cost $2.48"), await plate.innerText());
  await cell.fill("8");
  const live = (await plate.innerText()).replace(/\n/g, " ");
  check("Large plate cost updates live to $2.98 against $16.99, 82.5% margin", live.includes("Cost $2.98") && live.includes("Price $16.99") && live.includes("82.5% margin"), live);
  await page.getByRole("button", { name: "Save recipe" }).click();
  check(
    "Large mozzarella stored as 8 oz = 226800 milli g",
    await eventually(async () => (await db.select().from(recipeLines).where(largeMozz))[0]?.qtyMilli === 226_800),
  );
  check("item recipe has no stray lines (9 rows)", (await db.select().from(recipeLines).where(eq(recipeLines.menuItemId, cheese))).length === 9);
  await page.reload({ waitUntil: "networkidle" });
  check("after reload the Large plate costs $2.98", (await page.getByTestId(`plate-${large}`).innerText()).includes("Cost $2.98"));

  for (const [p, suffix] of [[page, "desktop"], [phone, "375"]] as const) {
    await p.goto(`${BASE}/admin/menu/items/${cheese}`, { waitUntil: "networkidle" });
    await p.locator("#recipe-heading").scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${SHOT_DIR}/item-recipe-${suffix}.png`, fullPage: true });
  }
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("item editor: no sideways scroll at 375 px", overflow <= 0, `overflow ${overflow}px`);
}

async function settingsFlow(page: Page, phone: Page) {
  await page.goto(`${BASE}/admin/settings`, { waitUntil: "networkidle" });
  await page.fill("#s-extraPortionPct", "350");
  check("extra portion above 300% is refused by the form", !(await page.$eval("#s-extraPortionPct", (el) => (el as HTMLInputElement).validity.valid)));
  await page.fill("#s-halfToppingPricePct", "60");
  await page.fill("#s-halfPortionPct", "55");
  await page.fill("#s-lightPortionPct", "40");
  await page.fill("#s-extraPortionPct", "200");
  await page.fill("#s-minMarginPct", "65.5");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.waitForURL(/saved=1/);
  const [row] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
  const got = [row.halfToppingPriceBps, row.halfPortionBps, row.lightPortionBps, row.extraPortionBps, row.minMarginBps];
  check("settings stored in basis points", JSON.stringify(got) === JSON.stringify([6000, 5500, 4000, 20000, 6550]), JSON.stringify(got));
  check("settings page reads them back as percents", (await page.inputValue("#s-minMarginPct")) === "65.5");
  await shoot(page, phone, "/admin/settings", "settings");
}

async function deleteGuardFlow(page: Page, provoloneId: number) {
  const mozz = (await ingredientByName("Whole-milk mozzarella")).id;
  await page.goto(`${BASE}/admin/inventory/ingredients/${mozz}`, { waitUntil: "networkidle" });
  const section = page.getByTestId("delete-ingredient");
  check("an ingredient in recipes offers no delete", (await section.innerText()).includes("can’t be deleted") && (await section.getByRole("button").count()) === 0, await section.innerText());
  check("its base unit is locked", await page.locator("#ing-base").isDisabled());

  await page.goto(`${BASE}/admin/inventory/ingredients/${provoloneId}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Delete ingredient" }).click();
  await page.getByRole("button", { name: "Really delete?" }).click();
  await page.waitForURL(/deleted=1/);
  check("an unused ingredient deletes", (await db.select().from(ingredients).where(eq(ingredients.id, provoloneId))).length === 0);
}

async function thresholdFlow(page: Page) {
  const { item, mod } = await ids();
  const pepperoni = (await ingredientByName("Pepperoni")).id;
  const hit = [item("Pepperoni Classic"), item("Meat Lovers")];
  const topping = mod("Extra Toppings", "Pepperoni");
  await db.update(menuItems).set({ isAvailable: true }).where(inArray(menuItems.id, hit));
  await db.update(modifiers).set({ isAvailable: true }).where(eq(modifiers.id, topping));
  await recordMoves([{ ingredientId: pepperoni, kind: "receive", qtyMilli: 2 * 453_592, vendor: VENDOR }]);

  const availability = async () => {
    const items = await db.select().from(menuItems).where(inArray(menuItems.id, hit));
    const [m] = await db.select().from(modifiers).where(eq(modifiers.id, topping));
    return [...items.map((i) => i.isAvailable), m.isAvailable];
  };
  check("received pepperoni, nothing 86'd yet", (await availability()).every(Boolean));

  await page.goto(`${BASE}/admin/inventory/ingredients/${pepperoni}`, { waitUntil: "networkidle" });
  await page.fill("#ing-out", "5");
  await page.getByLabel("86 unit").selectOption("lb");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(/saved=1/);
  check("86 threshold above on hand 86's Pepperoni Classic, Meat Lovers and the Pepperoni topping", await eventually(async () => (await availability()).every((a) => !a)), JSON.stringify(await availability()));
  const [out] = await db.select().from(stockOuts).where(eq(stockOuts.ingredientId, pepperoni));
  check("a stock-out row lists what it 86'd", !!out && hit.every((id) => out.menuItemIds.includes(id)) && out.modifierIds.includes(topping), JSON.stringify(out));

  await page.goto(`${BASE}/admin/inventory/ingredients/${pepperoni}`, { waitUntil: "networkidle" });
  await page.fill("#ing-out", "");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(/saved=1/);
  check("clearing the threshold brings them back", await eventually(async () => (await availability()).every(Boolean)), JSON.stringify(await availability()));
  check("and removes the stock-out row", (await db.select().from(stockOuts).where(eq(stockOuts.ingredientId, pepperoni))).length === 0);
  const [after] = await db.select().from(ingredients).where(eq(ingredients.id, pepperoni));
  check("clearing stores a null threshold", after.outAtMilli === null);
}

async function ingredientFlow(page: Page, phone: Page) {
  await page.goto(`${BASE}/admin/inventory/ingredients/new`, { waitUntil: "networkidle" });
  await page.fill("#ing-name", PROVOLONE);
  await page.selectOption("#ing-base", "g");
  await page.getByRole("button", { name: "Add pack" }).click();
  const pack = page.getByTestId("pack-row").first();
  await pack.getByLabel("Pack name").fill("case");
  await pack.getByLabel("Units in the pack").fill("4");
  await pack.getByLabel("Size of each unit").fill("5");
  await pack.getByLabel("Pack size unit").selectOption("lb");
  await page.fill("#ing-cost", "38.50");
  await page.getByLabel("Cost unit").selectOption("case");
  await page.fill("#ing-area", "Walk-in");
  await page.fill("#ing-low", "10");
  await page.getByLabel("Low stock unit").selectOption("lb");
  await page.fill("#ing-out", "2");
  await page.getByLabel("86 unit").selectOption("lb");
  await page.screenshot({ path: `${SHOT_DIR}/ingredient-form-filled.png`, fullPage: true });
  await page.getByRole("button", { name: "Create ingredient" }).click();
  await page.waitForURL(/\/admin\/inventory\/ingredients\?saved=1$/);

  const row = await ingredientByName(PROVOLONE);
  check("ingredient stored per gram: $38.50 per 20 lb case = 424 millicents/g", row?.unitCostMillicents === 424, `${row?.unitCostMillicents}`);
  check("thresholds stored in milli grams", row?.lowStockAtMilli === 4_535_920 && row?.outAtMilli === 907_184, `${row?.lowStockAtMilli} / ${row?.outAtMilli}`);
  const packs = await db.select().from(ingredientPacks).where(eq(ingredientPacks.ingredientId, row.id));
  check("case pack = 4 × 5 lb = 9071840 milli g", packs.length === 1 && packs[0].name === "case" && packs[0].baseQtyMilli === 9_071_840, JSON.stringify(packs.map((p) => [p.name, p.baseQtyMilli])));
  const listed = await page.getByTestId(`ingredient-${row.id}`).innerText();
  check("list shows cost per pound", listed.includes("$1.92/lb"), listed.replace(/\n/g, " | "));
  check("list shows thresholds", listed.includes("Low 10 lb") && listed.includes("86 at 2 lb"), listed.replace(/\n/g, " | "));

  await page.goto(`${BASE}/admin/inventory/ingredients/${row.id}`, { waitUntil: "networkidle" });
  check("edit form shows the case pack back", (await page.getByTestId("pack-row").first().getByLabel("Pack name").inputValue()) === "case");
  check("edit form shows cost per lb", (await page.inputValue("#ing-cost")) === "1.9232");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(/\?saved=1$/);
  const resaved = await ingredientByName(PROVOLONE);
  check("re-saving unchanged keeps the cost", resaved.unitCostMillicents === 424, `${resaved.unitCostMillicents}`);

  await shoot(page, phone, "/admin/inventory/ingredients", "ingredient-list");
  await shoot(page, phone, `/admin/inventory/ingredients/${row.id}`, "ingredient-form");
  return row.id;
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  await cleanup();
  await db.insert(operators).values({
    email: EMAIL,
    name: "Recipe Tester",
    passwordHash: await bcrypt.hash(PASSWORD, 10),
  });

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await signIn(browser, 1366);
  const phone = await signIn(browser, 375);
  try {
    const provolone = await ingredientFlow(page, phone);
    await groupKindsFlow(page);
    await toppingFlow(page, phone);
    await removalFlow(page);
    await itemRecipeFlow(page, phone);
    await settingsFlow(page, phone);
    await thresholdFlow(page);
    await deleteGuardFlow(page, provolone);
  } finally {
    await browser.close();
    await cleanup();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
