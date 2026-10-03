"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { db, ingredientPacks, ingredients, inventoryMoves, recipeLines } from "@/db";
import { requireOperator } from "@/lib/auth";
import { syncStockOuts } from "@/lib/inventory";
import { costToMillicents, unitFor } from "@/lib/unit-entry";
import { BASE_UNITS, UNITS, type BaseUnit, type UnitDef } from "@/lib/units";

export type IngredientFormState = { error?: string };

type IngredientInput = {
  values: Omit<typeof ingredients.$inferInsert, "id" | "createdAt">;
  packs: UnitDef[];
};

const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === "string" ? v.trim() : "";
};

const amount = z.coerce.number().finite();

function parseIngredient(fd: FormData): IngredientInput | { error: string } {
  const name = text(fd, "name");
  if (!name) return { error: "Name the ingredient." };
  const baseUnit = z.enum(BASE_UNITS).safeParse(text(fd, "baseUnit"));
  if (!baseUnit.success) return { error: "Pick how it is measured." };
  const base: BaseUnit = baseUnit.data;

  const packs: UnitDef[] = [];
  const counts = fd.getAll("packCount");
  const sizes = fd.getAll("packSize");
  const units = fd.getAll("packUnit");
  for (const [i, raw] of fd.getAll("packName").entries()) {
    const packName = String(raw).trim();
    if (!packName) continue;
    if (UNITS[base].some((u) => u.name === packName) || packs.some((p) => p.name === packName)) {
      return { error: `"${packName}" is already a unit name.` };
    }
    const packCount = amount.safeParse(counts[i] || "1");
    const packSize = amount.safeParse(sizes[i]);
    const unit = unitFor(String(units[i] ?? ""), base);
    if (!packCount.success || !packSize.success || !unit || packCount.data <= 0 || packSize.data <= 0) {
      return { error: `Say how much a ${packName} holds.` };
    }
    packs.push({
      name: packName,
      baseQtyMilli: Math.round(packCount.data * packSize.data * unit.baseQtyMilli),
    });
  }

  const cost = amount.safeParse(text(fd, "cost") || "0");
  const costUnit = unitFor(text(fd, "costUnit"), base, packs);
  if (!cost.success || cost.data < 0 || !costUnit) return { error: "Enter a cost of $0 or more." };

  const threshold = (qtyField: string, unitField: string): { milli: number | null } | { error: string } => {
    const raw = text(fd, qtyField);
    if (raw === "") return { milli: null };
    const qty = amount.safeParse(raw);
    const unit = unitFor(text(fd, unitField), base, packs);
    if (!qty.success || qty.data < 0 || !unit) return { error: "Thresholds must be 0 or more." };
    return { milli: Math.round(qty.data * unit.baseQtyMilli) };
  };
  const low = threshold("lowQty", "lowUnit");
  if ("error" in low) return low;
  const out = threshold("outQty", "outUnit");
  if ("error" in out) return out;

  return {
    values: {
      name,
      baseUnit: base,
      unitCostMillicents: costToMillicents(cost.data * 100, costUnit),
      storageArea: text(fd, "storageArea") || "Walk-in",
      shelfOrder: Math.max(0, Number.parseInt(text(fd, "shelfOrder"), 10) || 0),
      lowStockAtMilli: low.milli,
      outAtMilli: out.milli,
      isActive: fd.get("isActive") === "on",
    },
    packs,
  };
}

async function references(ingredientId: number) {
  const [[moves], [lines]] = await Promise.all([
    db.select({ n: count() }).from(inventoryMoves).where(eq(inventoryMoves.ingredientId, ingredientId)),
    db.select({ n: count() }).from(recipeLines).where(eq(recipeLines.ingredientId, ingredientId)),
  ]);
  return { moves: moves.n, recipeLines: lines.n };
}

function revalidateInventory() {
  revalidatePath("/admin", "layout");
  revalidatePath("/");
}

export async function saveIngredient(
  _prev: IngredientFormState,
  fd: FormData,
): Promise<IngredientFormState> {
  await requireOperator();
  const parsed = parseIngredient(fd);
  if ("error" in parsed) return parsed;
  const { values, packs } = parsed;

  const idRaw = text(fd, "ingredientId");
  if (idRaw) {
    const id = z.coerce.number().int().positive().parse(idRaw);
    const [existing] = await db
      .select({ baseUnit: ingredients.baseUnit })
      .from(ingredients)
      .where(eq(ingredients.id, id));
    if (!existing) return { error: "That ingredient no longer exists." };
    if (existing.baseUnit !== values.baseUnit) {
      const refs = await references(id);
      if (refs.moves > 0 || refs.recipeLines > 0) {
        return { error: "Its unit is fixed once it has stock history or recipe lines." };
      }
    }
    await db.batch([
      db.update(ingredients).set(values).where(eq(ingredients.id, id)),
      db.delete(ingredientPacks).where(eq(ingredientPacks.ingredientId, id)),
      ...packs.map((p) => db.insert(ingredientPacks).values({ ingredientId: id, ...p })),
    ]);
  } else {
    const [created] = await db.insert(ingredients).values(values).returning({ id: ingredients.id });
    if (packs.length) {
      await db.insert(ingredientPacks).values(packs.map((p) => ({ ingredientId: created.id, ...p })));
    }
  }

  await syncStockOuts();
  revalidateInventory();
  redirect("/admin/inventory/ingredients?saved=1");
}

export async function deleteIngredient(fd: FormData): Promise<void> {
  await requireOperator();
  const id = z.coerce.number().int().positive().parse(text(fd, "ingredientId"));
  const refs = await references(id);
  if (refs.moves > 0 || refs.recipeLines > 0) {
    redirect(`/admin/inventory/ingredients/${id}?notice=in-use`);
  }
  await db.delete(ingredients).where(eq(ingredients.id, id));
  await syncStockOuts();
  revalidateInventory();
  redirect("/admin/inventory/ingredients?deleted=1");
}
