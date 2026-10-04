import "server-only";
import { asc, eq, inArray, isNotNull } from "drizzle-orm";
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
import { DEFAULT_PORTIONS } from "@/lib/recipes";
import { loadSizePrices } from "@/lib/menu-server";
import { itemOptions, plateDefaults } from "@/lib/pricing";
import type {
  PlateContext,
  RecipeIngredient,
  RecipeSize,
  StoredLine,
} from "@/components/admin/recipe-editor";

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

export function sizeModifiers() {
  return db
    .select({
      id: modifiers.id,
      name: modifiers.name,
      groupId: modifiers.groupId,
      priceDeltaCents: modifiers.priceDeltaCents,
      isDefault: modifiers.isDefault,
      isAvailable: modifiers.isAvailable,
    })
    .from(modifiers)
    .innerJoin(modifierGroups, eq(modifierGroups.id, modifiers.groupId))
    .where(eq(modifierGroups.role, "size"))
    .orderBy(asc(modifierGroups.sortOrder), asc(modifiers.sortOrder), asc(modifiers.id));
}

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

export async function itemRecipe(item: { id: number; basePriceCents: number }): Promise<{
  sizes: RecipeSize[];
  lines: StoredLine[];
  plate: PlateContext;
}> {
  const [attached, allSizes, lines, [settings]] = await Promise.all([
    db
      .select({
        groupId: modifierGroups.id,
        role: modifierGroups.role,
        defaultModifierIds: itemModifierGroups.defaultModifierIds,
        hiddenModifierIds: itemModifierGroups.hiddenModifierIds,
        soldOutModifierIds: itemModifierGroups.soldOutModifierIds,
      })
      .from(itemModifierGroups)
      .innerJoin(modifierGroups, eq(modifierGroups.id, itemModifierGroups.groupId))
      .where(eq(itemModifierGroups.itemId, item.id))
      .orderBy(asc(itemModifierGroups.sortOrder)),
    sizeModifiers(),
    db.select().from(recipeLines).where(eq(recipeLines.menuItemId, item.id)),
    db.select().from(storeSettings).where(eq(storeSettings.id, 1)),
  ]);
  const sizeLink = attached.find((g) => g.role === "size");
  const sizes = sizeLink ? itemOptions(allSizes.filter((s) => s.groupId === sizeLink.groupId), sizeLink) : [];
  const optionGroups = attached.filter((g) => g.role !== "size");

  const optionMods = optionGroups.length
    ? await db
        .select({
          id: modifiers.id,
          groupId: modifiers.groupId,
          priceDeltaCents: modifiers.priceDeltaCents,
          extraPriceDeltaCents: modifiers.extraPriceDeltaCents,
          isDefault: modifiers.isDefault,
          isAvailable: modifiers.isAvailable,
        })
        .from(modifiers)
        .where(inArray(modifiers.groupId, optionGroups.map((g) => g.groupId)))
    : [];
  const sizePrices = await loadSizePrices(optionMods.map((m) => m.id));
  const plateGroups = optionGroups.map((g) => ({
    role: g.role,
    modifiers: itemOptions(
      optionMods.filter((m) => m.groupId === g.groupId).map((m) => ({ ...m, sizePrices: sizePrices.get(m.id) ?? [] })),
      g,
    ),
  }));
  const defaults = plateDefaults(plateGroups, null);
  const defaultIds = defaults.ids;
  const defaultLines = defaultIds.length
    ? await db.select().from(recipeLines).where(inArray(recipeLines.modifierId, defaultIds))
    : [];

  return {
    sizes: sizes.map((s) => ({ id: s.id, name: s.name })),
    lines,
    plate: {
      priceCents: Object.fromEntries([
        ["all", item.basePriceCents + defaults.priceCents],
        ...sizes.map((s) => [String(s.id), item.basePriceCents + plateDefaults(plateGroups, s.id).priceCents + s.priceDeltaCents]),
      ]),
      defaultModifierIds: defaultIds,
      modifierLines: defaultLines.map(recipeLineFromRow),
      sizeModifierIds: allSizes.map((s) => s.id),
      settings: settings
        ? {
            halfPortionBps: settings.halfPortionBps,
            lightPortionBps: settings.lightPortionBps,
            extraPortionBps: settings.extraPortionBps,
          }
        : DEFAULT_PORTIONS,
      minMarginBps: settings?.minMarginBps ?? 7000,
    },
  };
}
