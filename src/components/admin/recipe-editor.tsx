"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { saveRecipe } from "@/app/admin/actions";
import { SubmitButton } from "@/components/admin/order-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { formatCents } from "@/lib/money";
import {
  buildRecipeBook,
  plateCost,
  type RecipeLine,
  type RecipeOwner,
} from "@/lib/recipes";
import type { PortionSettings } from "@/lib/toppings";
import { amountIn, readableUnit, unitFor } from "@/lib/unit-entry";
import { trimAmount, unitsFor, type BaseUnit, type UnitDef } from "@/lib/units";

export type RecipeIngredient = {
  id: number;
  name: string;
  baseUnit: BaseUnit;
  unitCostMillicents: number;
  packs: UnitDef[];
};

export type RecipeSize = { id: number; name: string };

export type StoredLine = { sizeModifierId: number | null; ingredientId: number; qtyMilli: number };

export type PlateContext = {
  priceCents: Record<string, number>;
  defaultModifierIds: number[];
  modifierLines: RecipeLine[];
  sizeModifierIds: number[];
  settings: PortionSettings;
  minMarginBps: number;
};

const ALL = "all";
type Column = { key: string; sizeId: number | null; name: string };
type Row = { ingredientId: number; unit: string; cells: Record<string, string> };

function initialRows(lines: StoredLine[], byId: Map<number, RecipeIngredient>): Row[] {
  const ids = [...new Set(lines.map((l) => l.ingredientId))].filter((id) => byId.has(id));
  return ids.map((id) => {
    const mine = lines.filter((l) => l.ingredientId === id);
    const unit = readableUnit(mine.map((l) => l.qtyMilli), byId.get(id)!.baseUnit);
    return {
      ingredientId: id,
      unit: unit.name,
      cells: Object.fromEntries(
        mine.map((l) => [l.sizeModifierId === null ? ALL : String(l.sizeModifierId), amountIn(l.qtyMilli, unit)]),
      ),
    };
  });
}

function toLines(rows: Row[], columns: Column[], byId: Map<number, RecipeIngredient>) {
  return rows.flatMap((row) => {
    const ingredient = byId.get(row.ingredientId)!;
    const unit = unitFor(row.unit, ingredient.baseUnit, ingredient.packs);
    return columns.flatMap((col) => {
      const qty = Number.parseFloat(row.cells[col.key] ?? "");
      if (!unit || !Number.isFinite(qty) || qty === 0) return [];
      return [{ ingredientId: row.ingredientId, sizeModifierId: col.sizeId, qtyMilli: Math.round(qty * unit.baseQtyMilli) }];
    });
  });
}

export function RecipeEditor({
  owner,
  sizes,
  ingredients,
  lines,
  allowRemoval,
  plate,
}: {
  owner: RecipeOwner;
  sizes: RecipeSize[];
  ingredients: RecipeIngredient[];
  lines: StoredLine[];
  allowRemoval: boolean;
  plate?: PlateContext;
}) {
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const columns: Column[] = [
    { key: ALL, sizeId: null, name: "All sizes" },
    ...sizes.map((s) => ({ key: String(s.id), sizeId: s.id, name: s.name })),
  ];
  const [rows, setRows] = useState(() => initialRows(lines, byId));
  const unused = ingredients.filter((i) => !rows.some((r) => r.ingredientId === i.id));
  const [adding, setAdding] = useState<string>("");
  const prefix = `${owner.kind}-${owner.id}`;

  const updateRow = (ingredientId: number, patch: (row: Row) => Row) =>
    setRows((all) => all.map((r) => (r.ingredientId === ingredientId ? patch(r) : r)));

  function add() {
    const ingredient = byId.get(Number(adding || unused[0]?.id));
    if (!ingredient) return;
    const unit = readableUnit([], ingredient.baseUnit);
    setRows((all) => [...all, { ingredientId: ingredient.id, unit: unit.name, cells: {} }]);
    setAdding("");
  }

  const current = toLines(rows, columns, byId);

  return (
    <form
      action={async (fd) => {
        const result = await saveRecipe(fd);
        if (result.error) toast.error(result.error);
        else toast.success("Recipe saved");
      }}
      className="space-y-3"
      data-testid={`recipe-${prefix}`}
    >
      <input type="hidden" name="owner" value={owner.kind} />
      <input type="hidden" name="ownerId" value={owner.id} />
      <input
        type="hidden"
        name="lines"
        value={JSON.stringify(
          rows.flatMap((r) =>
            columns
              .filter((c) => (r.cells[c.key] ?? "").trim() !== "")
              .map((c) => ({
                ingredientId: r.ingredientId,
                sizeModifierId: c.sizeId,
                qty: Number.parseFloat(r.cells[c.key]),
                unit: r.unit,
              })),
          ),
        )}
      />

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No ingredients yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-max text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Ingredient</th>
                <th className="px-2 py-2 text-left font-medium">Unit</th>
                {columns.map((c) => (
                  <th key={c.key} className="px-2 py-2 text-left font-medium whitespace-nowrap">
                    {c.name}
                  </th>
                ))}
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => {
                const ingredient = byId.get(row.ingredientId)!;
                return (
                  <tr key={row.ingredientId}>
                    <td className="px-3 py-1.5 font-medium whitespace-nowrap">{ingredient.name}</td>
                    <td className="px-2 py-1.5">
                      <NativeSelect
                        size="sm"
                        value={row.unit}
                        aria-label={`${ingredient.name} unit`}
                        onChange={(e) => updateRow(row.ingredientId, (r) => ({ ...r, unit: e.target.value }))}
                      >
                        {unitsFor(ingredient.baseUnit, ingredient.packs).map((u) => (
                          <NativeSelectOption key={u.name} value={u.name}>
                            {u.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </td>
                    {columns.map((c) => {
                      const value = row.cells[c.key] ?? "";
                      const removes = Number.parseFloat(value) < 0;
                      return (
                        <td key={c.key} className="px-2 py-1.5 align-top">
                          <Input
                            type="number"
                            step="any"
                            min={allowRemoval ? undefined : 0}
                            value={value}
                            placeholder={c.sizeId === null ? "—" : "as all"}
                            aria-label={`${ingredient.name} ${c.name}`}
                            onChange={(e) =>
                              updateRow(row.ingredientId, (r) => ({
                                ...r,
                                cells: { ...r.cells, [c.key]: e.target.value },
                              }))
                            }
                            className="h-8 w-20 tabular-nums"
                          />
                          {removes ? (
                            <span className="mt-0.5 block text-xs text-destructive">
                              removes {trimAmount(-Number.parseFloat(value))} {row.unit}
                            </span>
                          ) : null}
                        </td>
                      );
                    })}
                    <td className="px-1 py-1.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${ingredient.name}`}
                        onClick={() => setRows((all) => all.filter((r) => r.ingredientId !== row.ingredientId))}
                      >
                        <X />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        A size column overrides “All sizes” for that size; leave it blank to use “All sizes”.
        {allowRemoval
          ? " A negative quantity removes that much from the item’s recipe (e.g. No onions: −1 oz)."
          : null}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {unused.length > 0 ? (
          <>
            <NativeSelect
              size="sm"
              value={adding}
              aria-label="Ingredient to add"
              onChange={(e) => setAdding(e.target.value)}
            >
              {unused.map((i) => (
                <NativeSelectOption key={i.id} value={i.id}>
                  {i.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button type="button" variant="outline" size="sm" onClick={add}>
              <Plus /> Add ingredient
            </Button>
          </>
        ) : null}
        <SubmitButton size="sm" className="ml-auto">
          Save recipe
        </SubmitButton>
      </div>

      {plate && owner.kind === "item" ? (
        <PlateCosts itemId={owner.id} columns={columns} lines={current} ingredients={ingredients} plate={plate} />
      ) : null}
    </form>
  );
}

function PlateCosts({
  itemId,
  columns,
  lines,
  ingredients,
  plate,
}: {
  itemId: number;
  columns: Column[];
  lines: StoredLine[];
  ingredients: RecipeIngredient[];
  plate: PlateContext;
}) {
  const book = buildRecipeBook([
    ...plate.modifierLines,
    ...lines.map((l) => ({ owner: { kind: "item" as const, id: itemId }, ...l })),
  ]);
  const ctx = { book, sizeModifierIds: new Set(plate.sizeModifierIds), settings: plate.settings };
  const unitCosts = new Map(ingredients.map((i) => [i.id, i.unitCostMillicents]));
  const priced = columns.length > 1 ? columns.slice(1) : columns;

  return (
    <div className="rounded-lg border border-border" data-testid="plate-costs">
      <p className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
        Plate cost (with default options)
      </p>
      <ul className="divide-y divide-border">
        {priced.map((c) => {
          const cost = plateCost(itemId, c.sizeId, plate.defaultModifierIds, ctx, unitCosts);
          const price = plate.priceCents[c.key] ?? 0;
          const marginBps = price > 0 ? Math.round(((price - cost) * 10_000) / price) : null;
          const low = marginBps !== null && marginBps < plate.minMarginBps;
          return (
            <li
              key={c.key}
              data-testid={`plate-${c.key}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm"
            >
              <span className="min-w-24 flex-1 font-medium">{c.name}</span>
              <span className="tabular-nums">Cost {formatCents(cost)}</span>
              <span className="tabular-nums text-muted-foreground">Price {formatCents(price)}</span>
              <span className={`tabular-nums sm:w-24 sm:text-right ${low ? "font-medium text-destructive" : ""}`}>
                {marginBps === null ? "—" : `${trimAmount(marginBps / 100, 1)}% margin`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
