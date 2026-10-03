import type { Metadata } from "next";
import { db, ingredients } from "@/db";
import { requireOperator } from "@/lib/auth";
import { IngredientForm } from "../ingredient-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "New ingredient" };

export default async function NewIngredientPage() {
  await requireOperator();
  const areas = await db.selectDistinct({ area: ingredients.storageArea }).from(ingredients);

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">New ingredient</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Enter the cost the way your invoice shows it; it is stored per gram, milliliter or piece.
      </p>
      <div className="mt-6">
        <IngredientForm unitLocked={false} storageAreas={areas.map((a) => a.area).sort()} />
      </div>
    </div>
  );
}
