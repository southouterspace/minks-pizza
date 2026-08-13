import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import {
  categories,
  db,
  itemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
} from "@/db";
import { requireOperator } from "@/lib/auth";
import { ItemForm } from "@/components/admin/item-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Edit item" };

export default async function EditItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOperator();

  const { id } = await params;
  const itemId = Number.parseInt(id, 10);
  if (!Number.isInteger(itemId) || itemId <= 0) notFound();

  const [item] = await db
    .select()
    .from(menuItems)
    .where(eq(menuItems.id, itemId));
  if (!item) notFound();

  const allCategories = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .orderBy(asc(categories.sortOrder), asc(categories.id));

  const groups = await db
    .select()
    .from(modifierGroups)
    .orderBy(asc(modifierGroups.sortOrder), asc(modifierGroups.id));
  const allModifiers = await db
    .select({ id: modifiers.id, groupId: modifiers.groupId })
    .from(modifiers);
  const links = await db
    .select({ groupId: itemModifierGroups.groupId })
    .from(itemModifierGroups)
    .where(eq(itemModifierGroups.itemId, itemId));

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Edit item</h1>
      <p className="mt-1 text-sm text-muted">{item.name}</p>
      <div className="mt-6">
        <ItemForm
          item={{
            id: item.id,
            name: item.name,
            description: item.description,
            basePriceCents: item.basePriceCents,
            categoryId: item.categoryId,
            isAvailable: item.isAvailable,
            isFeatured: item.isFeatured,
          }}
          allCategories={allCategories}
          allGroups={groups.map((g) => ({
            id: g.id,
            name: g.name,
            minSelect: g.minSelect,
            maxSelect: g.maxSelect,
            modifierCount: allModifiers.filter((m) => m.groupId === g.id)
              .length,
          }))}
          selectedGroupIds={links.map((l) => l.groupId)}
        />
      </div>
    </div>
  );
}
