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
import Link from "next/link";
import { ItemForm, type OptionState } from "@/components/admin/item-form";
import { RecipeEditor } from "@/components/admin/recipe-editor";
import { itemRecipe, recipeIngredients } from "@/lib/recipe-data";

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
    .select({ id: modifiers.id, groupId: modifiers.groupId, name: modifiers.name })
    .from(modifiers)
    .orderBy(asc(modifiers.sortOrder), asc(modifiers.id));
  const [recipe, allIngredients] = await Promise.all([itemRecipe(item), recipeIngredients()]);
  const links = await db
    .select()
    .from(itemModifierGroups)
    .where(eq(itemModifierGroups.itemId, itemId))
    .orderBy(asc(itemModifierGroups.sortOrder), asc(itemModifierGroups.id));
  const stateOf = (link: (typeof links)[number], modifierId: number): OptionState =>
    link.hiddenModifierIds.includes(modifierId) ? "hidden" : link.soldOutModifierIds.includes(modifierId) ? "soldOut" : "offered";

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Edit item</h1>
      <p className="mt-1 text-sm text-muted-foreground">{item.name}</p>
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
            isAlcoholic: item.isAlcoholic,
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
          options={links.flatMap((l) => {
            const group = groups.find((g) => g.id === l.groupId);
            if (!group) return [];
            return [
              {
                groupId: group.id,
                groupName: group.name,
                modifiers: allModifiers
                  .filter((m) => m.groupId === group.id)
                  .map((m) => ({ id: m.id, name: m.name, state: stateOf(l, m.id) })),
              },
            ];
          })}
        />
      </div>

      <section className="mt-10 max-w-3xl border-t border-border pt-6" aria-labelledby="recipe-heading">
        <h2 id="recipe-heading" className="text-sm font-semibold">
          Recipe
        </h2>
        <p className="mt-1 mb-4 text-sm text-muted-foreground">
          What one plate uses, by size. Toppings and other options add their own recipes on the{" "}
          <Link href="/admin/modifiers" className="underline underline-offset-2 hover:text-foreground">
            Modifiers
          </Link>{" "}
          page; costs come from{" "}
          <Link
            href="/admin/inventory/ingredients"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Ingredients
          </Link>
          .
        </p>
        <RecipeEditor
          owner={{ kind: "item", id: item.id }}
          sizes={recipe.sizes}
          ingredients={allIngredients}
          lines={recipe.lines}
          allowRemoval={false}
          plate={recipe.plate}
        />
      </section>
    </div>
  );
}
