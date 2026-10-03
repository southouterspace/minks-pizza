/**
 * Starter ingredients and recipes for the seeded menu, so a fresh database
 * demos depletion, costing and auto-86 out of the box. Idempotent: group
 * kinds and extra prices are set by name, and ingredients and recipe lines
 * are inserted only where absent, so it is safe on a database that already
 * has some of this. No 86 thresholds: an ingredient that has never been
 * counted sits at zero on hand, and a threshold would 86 the whole menu
 * before the first count. Operators set them per ingredient.
 */
import { eq } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

type Db = NeonHttpDatabase<typeof schema>;

const OZ = 28_350;

/** $/lb as millicents per gram. */
const perLb = (dollars: number) => Math.round((dollars * 100 * 1000) / 453.592);

/** Ounces at Small, Medium, Large, X-Large. */
type BySize = readonly [number, number, number, number];
const SIZES = ['Small 10"', 'Medium 12"', 'Large 14"', 'X-Large 16"'] as const;

const INGREDIENTS: (typeof schema.ingredients.$inferInsert)[] = [
  { name: "Dough ball", baseUnit: "each", unitCostMillicents: 60_000, storageArea: "Walk-in", shelfOrder: 0, lowStockAtMilli: 40_000 },
  { name: "Pizza sauce", baseUnit: "g", unitCostMillicents: perLb(1.2), storageArea: "Walk-in", shelfOrder: 1, lowStockAtMilli: 10 * 453_592 },
  { name: "Whole-milk mozzarella", baseUnit: "g", unitCostMillicents: perLb(4.0), storageArea: "Walk-in", shelfOrder: 2, lowStockAtMilli: 20 * 453_592 },
  { name: "Pepperoni", baseUnit: "g", unitCostMillicents: perLb(5.5), storageArea: "Walk-in", shelfOrder: 3, lowStockAtMilli: 5 * 453_592 },
  { name: "Italian sausage", baseUnit: "g", unitCostMillicents: perLb(4.5), storageArea: "Walk-in", shelfOrder: 4, lowStockAtMilli: 5 * 453_592 },
  { name: "Bacon", baseUnit: "g", unitCostMillicents: perLb(6.0), storageArea: "Walk-in", shelfOrder: 5, lowStockAtMilli: 3 * 453_592 },
  { name: "Ham", baseUnit: "g", unitCostMillicents: perLb(4.0), storageArea: "Walk-in", shelfOrder: 6, lowStockAtMilli: 3 * 453_592 },
  { name: "Grilled chicken", baseUnit: "g", unitCostMillicents: perLb(5.0), storageArea: "Walk-in", shelfOrder: 7, lowStockAtMilli: 3 * 453_592 },
  { name: "Mushrooms", baseUnit: "g", unitCostMillicents: perLb(3.0), storageArea: "Make line", shelfOrder: 0, lowStockAtMilli: 3 * 453_592 },
  { name: "Red onions", baseUnit: "g", unitCostMillicents: perLb(1.0), storageArea: "Make line", shelfOrder: 1, lowStockAtMilli: 3 * 453_592 },
  { name: "Green peppers", baseUnit: "g", unitCostMillicents: perLb(1.6), storageArea: "Make line", shelfOrder: 2, lowStockAtMilli: 3 * 453_592 },
  { name: "Black olives", baseUnit: "g", unitCostMillicents: perLb(3.5), storageArea: "Make line", shelfOrder: 3, lowStockAtMilli: 2 * 453_592 },
  { name: "Tomatoes", baseUnit: "g", unitCostMillicents: perLb(1.8), storageArea: "Make line", shelfOrder: 4, lowStockAtMilli: 3 * 453_592 },
  { name: "Fresh basil", baseUnit: "g", unitCostMillicents: perLb(12.0), storageArea: "Make line", shelfOrder: 5, lowStockAtMilli: 4 * OZ },
  { name: "Pineapple", baseUnit: "g", unitCostMillicents: perLb(1.5), storageArea: "Make line", shelfOrder: 6, lowStockAtMilli: 2 * 453_592 },
  { name: "BBQ sauce", baseUnit: "g", unitCostMillicents: perLb(2.0), storageArea: "Make line", shelfOrder: 7, lowStockAtMilli: 2 * 453_592 },
];

const SAUCE: BySize = [3, 4, 5, 6];
const CHEESE: BySize = [5, 6, 8, 10];

/** Each pizza: toppings in ounces by size, on top of dough, sauce and cheese. */
const PIZZAS: Record<string, { sauce?: string; toppings: [string, BySize][] }> = {
  "Margherita": { toppings: [["Tomatoes", [2, 2.5, 3, 3.5]], ["Fresh basil", [0.2, 0.25, 0.3, 0.35]]] },
  "Pepperoni Classic": { toppings: [["Pepperoni", [3, 4, 5, 6]]] },
  "Meat Lovers": {
    toppings: [["Pepperoni", [1.5, 2, 2.5, 3]], ["Italian sausage", [1.5, 2, 2.5, 3]], ["Bacon", [1, 1.5, 2, 2.5]], ["Ham", [1, 1.5, 2, 2.5]]],
  },
  "Veggie Supreme": {
    toppings: [["Mushrooms", [1, 1.5, 2, 2.5]], ["Green peppers", [1, 1.5, 2, 2.5]], ["Red onions", [1, 1.5, 2, 2.5]], ["Black olives", [1, 1.5, 2, 2.5]], ["Tomatoes", [1, 1.5, 2, 2.5]]],
  },
  "BBQ Chicken": { sauce: "BBQ sauce", toppings: [["Grilled chicken", [2, 3, 4, 5]], ["Red onions", [0.5, 0.75, 1, 1.25]]] },
  "Cheese Pizza": { toppings: [] },
};

/** "Extra Toppings" modifiers: ingredient, ounces by size, and the extra-portion price. */
const TOPPINGS: Record<string, { ingredient: string; oz: BySize; extraPriceCents: number }> = {
  "Pepperoni": { ingredient: "Pepperoni", oz: [1.5, 2, 3, 3.5], extraPriceCents: 300 },
  "Italian Sausage": { ingredient: "Italian sausage", oz: [1.5, 2, 3, 3.5], extraPriceCents: 300 },
  "Bacon": { ingredient: "Bacon", oz: [1, 1.5, 2, 2.5], extraPriceCents: 350 },
  "Mushrooms": { ingredient: "Mushrooms", oz: [1, 1.5, 2, 2.5], extraPriceCents: 250 },
  "Red Onions": { ingredient: "Red onions", oz: [1, 1.5, 2, 2.5], extraPriceCents: 200 },
  "Green Peppers": { ingredient: "Green peppers", oz: [1, 1.5, 2, 2.5], extraPriceCents: 200 },
  "Black Olives": { ingredient: "Black olives", oz: [1, 1.5, 2, 2.5], extraPriceCents: 250 },
  "Fresh Basil": { ingredient: "Fresh basil", oz: [0.2, 0.25, 0.3, 0.35], extraPriceCents: 200 },
  "Extra Cheese": { ingredient: "Whole-milk mozzarella", oz: [2, 3, 4, 5], extraPriceCents: 350 },
  "Pineapple": { ingredient: "Pineapple", oz: [1, 1.5, 2, 2.5], extraPriceCents: 250 },
};

type Line = typeof schema.recipeLines.$inferInsert;

export async function seedInventory(db: Db): Promise<{ ingredients: number; recipeLines: number }> {
  const groups = await db.select().from(schema.modifierGroups);
  const sizeGroup = groups.find((g) => g.name === "Size");
  const toppingsGroup = groups.find((g) => g.name === "Extra Toppings");
  if (!sizeGroup || !toppingsGroup) throw new Error("Seed the menu first: Size and Extra Toppings groups are missing.");
  await db.update(schema.modifierGroups).set({ kind: "size" }).where(eq(schema.modifierGroups.id, sizeGroup.id));
  await db.update(schema.modifierGroups).set({ kind: "toppings" }).where(eq(schema.modifierGroups.id, toppingsGroup.id));

  const mods = await db.select().from(schema.modifiers);
  const sizeIds = SIZES.map((name) => mods.find((m) => m.groupId === sizeGroup.id && m.name === name)?.id ?? null);
  for (const [name, topping] of Object.entries(TOPPINGS)) {
    const mod = mods.find((m) => m.groupId === toppingsGroup.id && m.name === name);
    if (mod && mod.extraPriceDeltaCents === null) {
      await db.update(schema.modifiers).set({ extraPriceDeltaCents: topping.extraPriceCents }).where(eq(schema.modifiers.id, mod.id));
    }
  }

  const existing = new Set((await db.select({ name: schema.ingredients.name }).from(schema.ingredients)).map((r) => r.name));
  const missing = INGREDIENTS.filter((i) => !existing.has(i.name));
  if (missing.length) await db.insert(schema.ingredients).values(missing);
  const ingredientId = new Map(
    (await db.select({ id: schema.ingredients.id, name: schema.ingredients.name }).from(schema.ingredients)).map((r) => [r.name, r.id]),
  );
  const ing = (name: string) => {
    const id = ingredientId.get(name);
    if (id === undefined) throw new Error(`Unknown ingredient "${name}"`);
    return id;
  };

  const items = await db.select({ id: schema.menuItems.id, name: schema.menuItems.name }).from(schema.menuItems);
  const lines: Line[] = [];
  const bySize = (owner: Pick<Line, "menuItemId" | "modifierId">, ingredient: string, oz: BySize) => {
    sizeIds.forEach((sizeModifierId, i) => {
      if (sizeModifierId !== null) {
        lines.push({ ...owner, sizeModifierId, ingredientId: ing(ingredient), qtyMilli: Math.round(oz[i] * OZ) });
      }
    });
  };
  for (const [name, pizza] of Object.entries(PIZZAS)) {
    const item = items.find((i) => i.name === name);
    if (!item) continue;
    const owner = { menuItemId: item.id, modifierId: null };
    lines.push({ ...owner, sizeModifierId: null, ingredientId: ing("Dough ball"), qtyMilli: 1_000 });
    bySize(owner, pizza.sauce ?? "Pizza sauce", SAUCE);
    bySize(owner, "Whole-milk mozzarella", CHEESE);
    for (const [ingredient, oz] of pizza.toppings) bySize(owner, ingredient, oz);
  }
  for (const [name, topping] of Object.entries(TOPPINGS)) {
    const mod = mods.find((m) => m.groupId === toppingsGroup.id && m.name === name);
    if (mod) bySize({ menuItemId: null, modifierId: mod.id }, topping.ingredient, topping.oz);
  }

  // The unique constraint treats nulls as equal, so a re-run skips every line it already wrote.
  const inserted = lines.length
    ? await db.insert(schema.recipeLines).values(lines).onConflictDoNothing().returning({ id: schema.recipeLines.id })
    : [];
  return { ingredients: missing.length, recipeLines: inserted.length };
}
