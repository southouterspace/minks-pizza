import "server-only";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  db,
  ingredientPacks,
  ingredients,
  itemModifierGroups,
  modifierGroups,
  modifiers,
  recipeLines,
  storeSettings,
} from "@/db";
import { recipeLineFromRow } from "@/lib/recipes";
import type {
  PlateContext,
  RecipeIngredient,
  RecipeSize,
  StoredLine,
} from "@/components/admin/recipe-editor";

/** Every ingredient with its packs, for the recipe grids' pickers and unit selects. */
export async function recipeIngredients(): Promise<RecipeIngredient[]> {
  const [rows, packs] = await Promise.all([
    db.select().from(ingredients).orderBy(asc(ingredients.name)),
    db.select().from(ingredientPacks).orderBy(asc(ingredientPacks.id)),
  ]);
  return rows.map((i) => ({
    id: i.id,
    name: i.name,
    baseUnit: i.baseUnit,
    unitCostMillicents: i.unitCostMillicents,
    packs: packs
      .filter((p) => p.ingredientId === i.id)
      .map((p) => ({ name: p.name, baseQtyMilli: p.baseQtyMilli })),
  }));
}

/** Modifiers of every `size` group, in menu order. */
export function sizeModifiers() {
  return db
    .select({
      id: modifiers.id,
      name: modifiers.name,
      groupId: modifiers.groupId,
      priceDeltaCents: modifiers.priceDeltaCents,
    })
    .from(modifiers)
    .innerJoin(modifierGroups, eq(modifierGroups.id, modifiers.groupId))
    .where(eq(modifierGroups.kind, "size"))
    .orderBy(asc(modifierGroups.sortOrder), asc(modifiers.sortOrder), asc(modifiers.id));
}

/** Recipe lines owned by modifiers, for the modifiers page. */
export function modifierRecipeLines() {
  return db
    .select({
      modifierId: recipeLines.modifierId,
      sizeModifierId: recipeLines.sizeModifierId,
      ingredientId: recipeLines.ingredientId,
      qtyMilli: recipeLines.qtyMilli,
    })
    .from(recipeLines)
    .where(isNotNull(recipeLines.modifierId));
}

/**
 * The item's recipe grid and what it takes to price a plate: the sizes of its
 * size group, its default options (and their recipes), and the price at each size.
 */
export async function itemRecipe(item: { id: number; basePriceCents: number }): Promise<{
  sizes: RecipeSize[];
  lines: StoredLine[];
  plate: PlateContext;
}> {
  const [attached, allSizes, lines, [settings]] = await Promise.all([
    db
      .select({ groupId: modifierGroups.id, kind: modifierGroups.kind })
      .from(itemModifierGroups)
      .innerJoin(modifierGroups, eq(modifierGroups.id, itemModifierGroups.groupId))
      .where(eq(itemModifierGroups.itemId, item.id))
      .orderBy(asc(itemModifierGroups.sortOrder)),
    sizeModifiers(),
    db.select().from(recipeLines).where(eq(recipeLines.menuItemId, item.id)),
    db.select().from(storeSettings).where(eq(storeSettings.id, 1)),
  ]);
  const sizeGroupId = attached.find((g) => g.kind === "size")?.groupId;
  const sizes = allSizes.filter((s) => s.groupId === sizeGroupId);
  const optionGroupIds = attached.filter((g) => g.kind !== "size").map((g) => g.groupId);

  const defaults = optionGroupIds.length
    ? await db
        .select({ id: modifiers.id, priceDeltaCents: modifiers.priceDeltaCents })
        .from(modifiers)
        .where(and(inArray(modifiers.groupId, optionGroupIds), eq(modifiers.isDefault, true)))
    : [];
  const defaultIds = defaults.map((d) => d.id);
  const defaultLines = defaultIds.length
    ? await db.select().from(recipeLines).where(inArray(recipeLines.modifierId, defaultIds))
    : [];

  const withDefaults = item.basePriceCents + defaults.reduce((sum, d) => sum + d.priceDeltaCents, 0);
  return {
    sizes: sizes.map((s) => ({ id: s.id, name: s.name })),
    lines,
    plate: {
      priceCents: Object.fromEntries([
        ["all", withDefaults],
        ...sizes.map((s) => [String(s.id), withDefaults + s.priceDeltaCents]),
      ]),
      defaultModifierIds: defaultIds,
      modifierLines: defaultLines.map(recipeLineFromRow),
      sizeModifierIds: allSizes.map((s) => s.id),
      settings: {
        halfPortionBps: settings?.halfPortionBps ?? 5000,
        lightPortionBps: settings?.lightPortionBps ?? 5000,
        extraPortionBps: settings?.extraPortionBps ?? 15000,
      },
      minMarginBps: settings?.minMarginBps ?? 7000,
    },
  };
}
