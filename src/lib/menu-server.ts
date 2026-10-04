import { createHash } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { categories, db, itemModifierGroups, menuItems, modifierGroups, modifiers } from "@/db";
import { rejected, type Failure, type PosMenu, type SubmitLine } from "@/lib/orders";
import { PricingError, priceLine, withItemDefaults, type MenuItem, type PricingPolicy } from "@/lib/pricing";
import { getSettings, policyOf } from "@/lib/settings-server";

async function loadMenuItems(itemIds?: number[]): Promise<(MenuItem & { categoryId: number })[]> {
  if (itemIds?.length === 0) return [];
  const rows = await db
    .select({ item: menuItems, station: categories.station })
    .from(menuItems)
    .innerJoin(categories, eq(categories.id, menuItems.categoryId))
    .where(itemIds ? inArray(menuItems.id, itemIds) : eq(categories.isActive, true))
    .orderBy(asc(menuItems.sortOrder), asc(menuItems.id));
  const ids = rows.map((r) => r.item.id);
  const links = ids.length
    ? await db
        .select()
        .from(itemModifierGroups)
        .where(inArray(itemModifierGroups.itemId, ids))
        .orderBy(asc(itemModifierGroups.sortOrder), asc(itemModifierGroups.id))
    : [];
  const groupIds = [...new Set(links.map((l) => l.groupId))];
  const [groups, mods] = groupIds.length
    ? await Promise.all([
        db.select().from(modifierGroups).where(inArray(modifierGroups.id, groupIds)),
        db
          .select()
          .from(modifiers)
          .where(inArray(modifiers.groupId, groupIds))
          .orderBy(asc(modifiers.sortOrder), asc(modifiers.id)),
      ])
    : [[], []];
  const groupById = new Map(groups.map((g) => [g.id, g]));

  return rows.map(({ item, station }) => ({
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    description: item.description,
    basePriceCents: item.basePriceCents,
    isAvailable: item.isAvailable,
    station,
    groups: links
      .filter((l) => l.itemId === item.id)
      .flatMap((l) => {
        const g = groupById.get(l.groupId);
        if (!g) return [];
        return [
          {
            id: g.id,
            name: g.name,
            role: g.role,
            minSelect: g.minSelect,
            maxSelect: g.maxSelect,
            modifiers: withItemDefaults(
              mods
                .filter((m) => m.groupId === g.id)
                .map((m) => ({
                  id: m.id,
                  name: m.name,
                  priceDeltaCents: m.priceDeltaCents,
                  extraPriceDeltaCents: m.extraPriceDeltaCents,
                  isDefault: m.isDefault,
                  isAvailable: m.isAvailable,
                })),
              l.defaultModifierIds,
            ),
          },
        ];
      }),
  }));
}

export async function getPosMenu(): Promise<PosMenu> {
  const [settings, items, cats] = await Promise.all([
    getSettings(),
    loadMenuItems(),
    db.select().from(categories).where(eq(categories.isActive, true)).orderBy(asc(categories.sortOrder)),
  ]);
  const body = {
    policy: policyOf(settings),
    taxRateBps: settings.taxRateBps,
    deliveryFeeCents: settings.deliveryFeeCents,
    discountApprovalCents: settings.discountApprovalCents,
    categories: cats.map((c) => ({
      id: c.id,
      name: c.name,
      items: items.filter((i) => i.categoryId === c.id),
    })),
  };
  const version = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { version, ...body };
}

export type PricedLine = SubmitLine & {
  name: string;
  categoryId: number;
  /** Chosen modifier ids, so promotions can target a size. */
  modifierIds: number[];
  station: MenuItem["station"];
  unitPriceCents: number;
  modifiers: ReturnType<typeof priceLine>["modifiers"];
};

export async function priceLines(lines: SubmitLine[], policy: PricingPolicy): Promise<PricedLine[] | Failure> {
  const items = new Map(
    (await loadMenuItems([...new Set(lines.map((l) => l.itemId))])).map((i) => [i.id, i]),
  );
  try {
    return lines.map((line) => {
      const item = items.get(line.itemId);
      if (!item) throw new PricingError("An item in this order is no longer on the menu.");
      const priced = priceLine(item, line.selections, policy);
      return {
        ...line,
        name: item.name,
        categoryId: item.categoryId,
        modifierIds: line.selections.map((s) => s.modifierId),
        station: item.station,
        ...priced,
      };
    });
  } catch (err) {
    if (err instanceof PricingError) return rejected(err.message);
    throw err;
  }
}
