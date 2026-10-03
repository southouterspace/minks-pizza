import {
  DEFAULT_CHOICE,
  selectionFactorBps,
  type Placement,
  type Portion,
  type PortionSettings,
} from "@/lib/toppings";

export type RecipeOwner = { kind: "item"; id: number } | { kind: "modifier"; id: number };

export type RecipeLine = {
  owner: RecipeOwner;
  sizeModifierId: number | null;
  ingredientId: number;
  qtyMilli: number;
};

export type RecipeLineRow = {
  menuItemId: number | null;
  modifierId: number | null;
  sizeModifierId: number | null;
  ingredientId: number;
  qtyMilli: number;
};

export function recipeLineFromRow(row: RecipeLineRow): RecipeLine {
  const owner: RecipeOwner =
    row.menuItemId !== null
      ? { kind: "item", id: row.menuItemId }
      : { kind: "modifier", id: row.modifierId ?? 0 };
  return {
    owner,
    sizeModifierId: row.sizeModifierId,
    ingredientId: row.ingredientId,
    qtyMilli: row.qtyMilli,
  };
}

export function ownerKey(owner: RecipeOwner): string {
  return `${owner.kind}:${owner.id}`;
}

export type RecipeBook = ReadonlyMap<string, readonly RecipeLine[]>;

export function buildRecipeBook(lines: readonly RecipeLine[]): RecipeBook {
  const book = new Map<string, RecipeLine[]>();
  for (const line of lines) {
    const key = ownerKey(line.owner);
    const list = book.get(key);
    if (list) list.push(line);
    else book.set(key, [line]);
  }
  return book;
}

export type Usage = Map<number, number>;

export function resolveLines(book: RecipeBook, owner: RecipeOwner, sizeId: number | null): Usage {
  const usage: Usage = new Map();
  const sized = new Set<number>();
  for (const line of book.get(ownerKey(owner)) ?? []) {
    if (line.sizeModifierId === sizeId && sizeId !== null) {
      usage.set(line.ingredientId, line.qtyMilli);
      sized.add(line.ingredientId);
    } else if (line.sizeModifierId === null && !sized.has(line.ingredientId)) {
      usage.set(line.ingredientId, line.qtyMilli);
    }
  }
  return usage;
}

export type UsageLine = {
  menuItemId: number | null;
  quantity: number;
  modifiers: readonly { modifierId?: number; placement?: Placement; portion?: Portion }[];
};

export type RecipeContext = {
  book: RecipeBook;
  sizeModifierIds: ReadonlySet<number>;
  settings: PortionSettings;
};

function add(into: Usage, from: Usage, factor: number) {
  for (const [ingredientId, qty] of from) {
    into.set(ingredientId, (into.get(ingredientId) ?? 0) + qty * factor);
  }
}

export function orderLineUsage(line: UsageLine, ctx: RecipeContext): Usage {
  const sizeId =
    line.modifiers.find((m) => m.modifierId !== undefined && ctx.sizeModifierIds.has(m.modifierId))
      ?.modifierId ?? null;
  const usage: Usage = new Map();
  if (line.menuItemId !== null) {
    add(usage, resolveLines(ctx.book, { kind: "item", id: line.menuItemId }, sizeId), 1);
  }
  for (const m of line.modifiers) {
    if (m.modifierId === undefined) continue;
    const choice = {
      placement: m.placement ?? DEFAULT_CHOICE.placement,
      portion: m.portion ?? DEFAULT_CHOICE.portion,
    };
    const factor = selectionFactorBps(choice, ctx.settings) / 10_000;
    add(usage, resolveLines(ctx.book, { kind: "modifier", id: m.modifierId }, sizeId), factor);
  }
  for (const [ingredientId, qty] of usage) {
    if (qty <= 0) usage.delete(ingredientId);
    else usage.set(ingredientId, qty * line.quantity);
  }
  return usage;
}

export function orderUsage(lines: readonly UsageLine[], ctx: RecipeContext): Usage {
  const total: Usage = new Map();
  for (const line of lines) add(total, orderLineUsage(line, ctx), 1);
  for (const [ingredientId, qty] of total) {
    const rounded = Math.round(qty);
    if (rounded === 0) total.delete(ingredientId);
    else total.set(ingredientId, rounded);
  }
  return total;
}

export type UnitCosts = ReadonlyMap<number, number>;

export function costCents(usage: Usage, unitCosts: UnitCosts): number {
  let millicentsTimesMilli = 0;
  for (const [ingredientId, qty] of usage) {
    millicentsTimesMilli += qty * (unitCosts.get(ingredientId) ?? 0);
  }
  return Math.round(millicentsTimesMilli / 1_000_000);
}

export function plateCost(
  itemId: number,
  sizeId: number | null,
  defaultModifierIds: readonly number[],
  ctx: RecipeContext,
  unitCosts: UnitCosts,
): number {
  const modifiers = [sizeId, ...defaultModifierIds]
    .filter((id): id is number => id !== null)
    .map((modifierId) => ({ modifierId }));
  return costCents(orderUsage([{ menuItemId: itemId, quantity: 1, modifiers }], ctx), unitCosts);
}
