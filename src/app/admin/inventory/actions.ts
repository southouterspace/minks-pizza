"use server";

import { revalidatePath } from "next/cache";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { db, ingredientPacks, ingredients } from "@/db";
import { requireOperator } from "@/lib/auth";
import { COUNT_KINDS, WASTE_REASONS } from "@/lib/inventory-domain";
import {
  recordCount,
  recordDelivery,
  recordMoves,
  type PriceChange,
} from "@/lib/inventory";
import { costToMillicents } from "@/lib/unit-entry";
import { unitsFor, type UnitDef } from "@/lib/units";

export type InventoryActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const qtyLine = z.object({
  ingredientId: z.number().int().positive(),
  qty: z.number().finite().nonnegative().max(1_000_000),
  unit: z.string().min(1).max(40),
});

async function unitsById(ids: readonly number[]): Promise<Map<number, UnitDef[]>> {
  if (ids.length === 0) return new Map();
  const [rows, packs] = await Promise.all([
    db
      .select({ id: ingredients.id, baseUnit: ingredients.baseUnit })
      .from(ingredients)
      .where(inArray(ingredients.id, [...ids])),
    db.select().from(ingredientPacks).where(inArray(ingredientPacks.ingredientId, [...ids])),
  ]);
  return new Map(
    rows.map((r) => [r.id, unitsFor(r.baseUnit, packs.filter((p) => p.ingredientId === r.id))]),
  );
}

function unitOf(units: Map<number, UnitDef[]>, line: z.infer<typeof qtyLine>): UnitDef | null {
  return units.get(line.ingredientId)?.find((u) => u.name === line.unit) ?? null;
}

function parseJson(fd: FormData): unknown {
  try {
    return JSON.parse(String(fd.get("payload") ?? ""));
  } catch {
    return null;
  }
}

function revalidateInventory(): void {
  revalidatePath("/admin", "layout");
}

const countPayload = z.object({
  kind: z.enum(COUNT_KINDS),
  lines: z.array(qtyLine).max(500),
});

export async function submitCount(fd: FormData): Promise<InventoryActionResult> {
  const operator = await requireOperator();
  const parsed = countPayload.safeParse(parseJson(fd));
  if (!parsed.success) return { ok: false, error: "Some quantities aren't numbers. Check the sheet." };
  const { kind, lines } = parsed.data;
  if (lines.length === 0) return { ok: false, error: "Count at least one ingredient." };

  const units = await unitsById(lines.map((l) => l.ingredientId));
  const counted = new Map<number, number>();
  for (const line of lines) {
    const unit = unitOf(units, line);
    if (!unit) return { ok: false, error: `"${line.unit}" isn't a unit for one of the lines.` };
    counted.set(line.ingredientId, Math.round(line.qty * unit.baseQtyMilli));
  }
  await recordCount({
    kind,
    operatorId: operator.id,
    lines: [...counted].map(([ingredientId, countedMilli]) => ({ ingredientId, countedMilli })),
  });
  revalidateInventory();
  return { ok: true };
}

const wasteForm = z.object({
  ingredientId: z.coerce.number().int().positive(),
  qty: z.coerce.number().finite().positive().max(1_000_000),
  unit: z.string().min(1).max(40),
  reason: z.enum(WASTE_REASONS),
});

export async function logWaste(fd: FormData): Promise<InventoryActionResult> {
  const operator = await requireOperator();
  const parsed = wasteForm.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { ok: false, error: "Pick an ingredient, a quantity above zero and a reason." };
  const line = parsed.data;
  const unit = unitOf(await unitsById([line.ingredientId]), line);
  if (!unit) return { ok: false, error: `"${line.unit}" isn't a unit for that ingredient.` };
  await recordMoves([
    {
      ingredientId: line.ingredientId,
      kind: "waste",
      qtyMilli: -Math.round(line.qty * unit.baseQtyMilli),
      wasteReason: line.reason,
      operatorId: operator.id,
    },
  ]);
  revalidateInventory();
  return { ok: true };
}

const deliveryPayload = z.object({
  vendor: z.string().trim().max(120),
  lines: z
    .array(qtyLine.extend({ qty: qtyLine.shape.qty.positive(), cost: z.number().finite().nonnegative().max(100_000) }))
    .max(200),
});

export async function receiveDelivery(
  fd: FormData,
): Promise<InventoryActionResult<{ lines: number; priceChanges: PriceChange[] }>> {
  const operator = await requireOperator();
  const parsed = deliveryPayload.safeParse(parseJson(fd));
  if (!parsed.success) return { ok: false, error: "Each line needs a quantity above zero and a cost." };
  const { vendor, lines } = parsed.data;
  if (lines.length === 0) return { ok: false, error: "Add at least one line." };

  const units = await unitsById(lines.map((l) => l.ingredientId));
  const moves = [];
  for (const line of lines) {
    const unit = unitOf(units, line);
    if (!unit) return { ok: false, error: `"${line.unit}" isn't a unit for one of the lines.` };
    moves.push({
      ingredientId: line.ingredientId,
      qtyMilli: Math.round(line.qty * unit.baseQtyMilli),
      unitCostMillicents: costToMillicents(line.cost * 100, unit),
    });
  }
  const priceChanges = await recordDelivery({
    vendor: vendor || null,
    operatorId: operator.id,
    lines: moves,
  });
  revalidateInventory();
  return { ok: true, lines: moves.length, priceChanges };
}
