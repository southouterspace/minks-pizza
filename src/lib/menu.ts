import { asc, eq, inArray } from "drizzle-orm";
import {
  categories,
  db,
  itemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
} from "@/db";
import { getSettings } from "@/lib/orders";
import type { ToppingPriceSettings } from "@/lib/toppings";

export type ModifierView = {
  id: number;
  name: string;
  priceDeltaCents: number;
  /** Null when "extra" is not offered. */
  extraPriceDeltaCents: number | null;
  isDefault: boolean;
};

type GroupFields = {
  id: number;
  name: string;
  minSelect: number;
  maxSelect: number | null;
  modifiers: ModifierView[];
};

/** Toppings groups carry the store's half price so the dialog charges what the server will. */
export type ModifierGroupView =
  | (GroupFields & { kind: "choice" | "size" })
  | (GroupFields & { kind: "toppings"; pricing: ToppingPriceSettings });

export type MenuItemView = {
  id: number;
  name: string;
  description: string | null;
  basePriceCents: number;
  imageUrl: string | null;
  isFeatured: boolean;
  modifierGroups: ModifierGroupView[];
};

export type CategoryView = {
  id: number;
  name: string;
  description: string | null;
  items: MenuItemView[];
};

/** Public menu: active categories, available items, available modifiers. */
export async function getPublicMenu(): Promise<CategoryView[]> {
  const cats = await db
    .select()
    .from(categories)
    .where(eq(categories.isActive, true))
    .orderBy(asc(categories.sortOrder), asc(categories.id));

  const items = cats.length
    ? await db
        .select()
        .from(menuItems)
        .where(
          inArray(
            menuItems.categoryId,
            cats.map((c) => c.id),
          ),
        )
        .orderBy(asc(menuItems.sortOrder), asc(menuItems.id))
    : [];

  const availableItems = items.filter((i) => i.isAvailable);

  const links = availableItems.length
    ? await db
        .select()
        .from(itemModifierGroups)
        .where(
          inArray(
            itemModifierGroups.itemId,
            availableItems.map((i) => i.id),
          ),
        )
        .orderBy(asc(itemModifierGroups.sortOrder))
    : [];

  const groupIds = [...new Set(links.map((l) => l.groupId))];
  const groups = groupIds.length
    ? await db
        .select()
        .from(modifierGroups)
        .where(inArray(modifierGroups.id, groupIds))
        .orderBy(asc(modifierGroups.sortOrder), asc(modifierGroups.id))
    : [];
  const mods = groupIds.length
    ? await db
        .select()
        .from(modifiers)
        .where(inArray(modifiers.groupId, groupIds))
        .orderBy(asc(modifiers.sortOrder), asc(modifiers.id))
    : [];

  const { halfToppingPriceBps } = await getSettings();

  const groupView = new Map<number, ModifierGroupView>(
    groups.map((g) => {
      const fields: GroupFields = {
        id: g.id,
        name: g.name,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        modifiers: mods
          .filter((m) => m.groupId === g.id && m.isAvailable)
          .map((m) => ({
            id: m.id,
            name: m.name,
            priceDeltaCents: m.priceDeltaCents,
            extraPriceDeltaCents: m.extraPriceDeltaCents,
            isDefault: m.isDefault,
          })),
      };
      return [
        g.id,
        g.kind === "toppings"
          ? { ...fields, kind: g.kind, pricing: { halfToppingPriceBps } }
          : { ...fields, kind: g.kind },
      ];
    }),
  );

  return cats
    .map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      items: availableItems
        .filter((i) => i.categoryId === c.id)
        .map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          basePriceCents: i.basePriceCents,
          imageUrl: i.imageUrl,
          isFeatured: i.isFeatured,
          modifierGroups: links
            .filter((l) => l.itemId === i.id)
            .map((l) => groupView.get(l.groupId))
            .filter((g): g is ModifierGroupView => Boolean(g)),
        })),
    }))
    .filter((c) => c.items.length > 0);
}
