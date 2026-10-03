import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { asc, count, eq } from "drizzle-orm";
import { db, ingredientPacks, ingredients, inventoryMoves, recipeLines } from "@/db";
import { requireOperator } from "@/lib/auth";
import { ConfirmButton } from "@/components/admin/confirm-button";
import { deleteIngredient } from "../actions";
import { IngredientForm } from "../ingredient-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Edit ingredient" };

export default async function EditIngredientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();
  const id = Number.parseInt((await params).id, 10);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const inUseNotice = (await searchParams).notice === "in-use";

  const [[ingredient], packs, [moves], [lines], areas] = await Promise.all([
    db.select().from(ingredients).where(eq(ingredients.id, id)),
    db
      .select({ name: ingredientPacks.name, baseQtyMilli: ingredientPacks.baseQtyMilli })
      .from(ingredientPacks)
      .where(eq(ingredientPacks.ingredientId, id))
      .orderBy(asc(ingredientPacks.id)),
    db.select({ n: count() }).from(inventoryMoves).where(eq(inventoryMoves.ingredientId, id)),
    db.select({ n: count() }).from(recipeLines).where(eq(recipeLines.ingredientId, id)),
    db.selectDistinct({ area: ingredients.storageArea }).from(ingredients),
  ]);
  if (!ingredient) notFound();
  const inUse = moves.n > 0 || lines.n > 0;
  const uses = [
    moves.n > 0 && `${moves.n} stock ${moves.n === 1 ? "entry" : "entries"}`,
    lines.n > 0 && `${lines.n} recipe ${lines.n === 1 ? "line" : "lines"}`,
  ].filter(Boolean);

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Edit ingredient</h1>
      <p className="mt-1 text-sm text-muted-foreground">{ingredient.name}</p>
      <div className="mt-6">
        <IngredientForm
          ingredient={{ ...ingredient, packs }}
          unitLocked={inUse}
          storageAreas={areas.map((a) => a.area).sort()}
        />
      </div>

      <section className="mt-10 max-w-xl border-t border-border pt-5" data-testid="delete-ingredient">
        <h2 className="text-sm font-semibold">Delete ingredient</h2>
        {inUse ? (
          <p className={`mt-1 text-sm ${inUseNotice ? "text-destructive" : "text-muted-foreground"}`}>
            It has {uses.join(" and ")}, so it can’t be deleted. Uncheck Active instead to hide it from
            counts and stop it 86’ing items.
          </p>
        ) : (
          <form action={deleteIngredient} className="mt-2">
            <input type="hidden" name="ingredientId" value={id} />
            <ConfirmButton label="Delete ingredient" confirmLabel="Really delete?" />
          </form>
        )}
      </section>
    </div>
  );
}
