import { orderLineUsage, type RecipeContext, type Usage, type UsageLine } from "@/lib/recipes";

/** Milli-units each tracked ingredient can still give to orders. Untracked ingredients are absent: they never limit. */
export type Stock = ReadonlyMap<number, number>;

/**
 * How many of each line the stock allows while every other line keeps its
 * quantity. Null for a line whose recipe touches no tracked ingredient.
 */
export function lineCaps(lines: readonly UsageLine[], ctx: RecipeContext, stock: Stock): (number | null)[] {
  const perUnit = lines.map((l) => orderLineUsage({ ...l, quantity: 1 }, ctx));
  const total: Usage = new Map();
  perUnit.forEach((usage, i) => {
    for (const [ingredientId, qty] of usage) {
      total.set(ingredientId, (total.get(ingredientId) ?? 0) + qty * lines[i].quantity);
    }
  });
  return perUnit.map((usage, i) => {
    let cap: number | null = null;
    for (const [ingredientId, qty] of usage) {
      const available = stock.get(ingredientId);
      if (available === undefined) continue;
      const others = (total.get(ingredientId) ?? 0) - qty * lines[i].quantity;
      // The epsilon keeps float dust from fractional portions from costing a whole unit.
      const fits = Math.max(0, Math.floor((available - others) / qty + 1e-9));
      cap = cap === null ? fits : Math.min(cap, fits);
    }
    return cap;
  });
}
