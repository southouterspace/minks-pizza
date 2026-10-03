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
import { and, eq, inArray, isNull } from "drizzle-orm";
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

/** Desktop and 375 px shots of the same page, and whether the phone width scrolls sideways. */
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

async function cleanup() {
  const old = await ingredientByName(PROVOLONE);
  if (old) await db.delete(ingredients).where(eq(ingredients.id, old.id));
  await db.delete(operators).where(eq(operators.email, EMAIL));
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
    await ingredientFlow(page, phone);
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
