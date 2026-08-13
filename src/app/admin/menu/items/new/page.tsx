import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { categories, db, modifierGroups, modifiers } from "@/db";
import { requireOperator } from "@/lib/auth";
import { ItemForm } from "@/components/admin/item-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "New item" };

export default async function NewItemPage() {
  await requireOperator();

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

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">New item</h1>
      <p className="mt-1 text-sm text-muted">
        Add a dish to your menu. You can attach modifier groups for sizes,
        crusts, and toppings.
      </p>
      <div className="mt-6">
        <ItemForm
          allCategories={allCategories}
          allGroups={groups.map((g) => ({
            id: g.id,
            name: g.name,
            minSelect: g.minSelect,
            maxSelect: g.maxSelect,
            modifierCount: allModifiers.filter((m) => m.groupId === g.id)
              .length,
          }))}
          selectedGroupIds={[]}
        />
      </div>
    </div>
  );
}
