"use client";

import Link from "next/link";
import { startTransition, useActionState, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  amountIn,
  centsPerUnit,
  COST_DISPLAY_UNIT,
  ENTRY_UNIT,
  readableUnit,
  unitFor,
} from "@/lib/unit-entry";
import {
  BASE_UNIT_LABEL,
  BASE_UNITS,
  trimAmount,
  UNITS,
  unitsFor,
  type BaseUnit,
  type UnitDef,
} from "@/lib/units";
import { saveIngredient, type IngredientFormState } from "./actions";

export type IngredientFormValue = {
  id: number;
  name: string;
  baseUnit: BaseUnit;
  unitCostMillicents: number;
  storageArea: string;
  shelfOrder: number;
  lowStockAtMilli: number | null;
  outAtMilli: number | null;
  isActive: boolean;
  packs: UnitDef[];
};

type PackRow = { key: number; name: string; count: string; size: string; unit: string };

/** A quantity as an amount in a readable unit, for prefilling an input pair. */
function asEntry(milli: number | null, baseUnit: BaseUnit): { qty: string; unit: string } {
  if (milli === null) return { qty: "", unit: ENTRY_UNIT[baseUnit] };
  const unit = readableUnit([milli], baseUnit);
  return { qty: amountIn(milli, unit), unit: unit.name };
}

function initialCost(ingredient: IngredientFormValue | undefined): string {
  if (!ingredient) return "";
  const unit = unitFor(COST_DISPLAY_UNIT[ingredient.baseUnit], ingredient.baseUnit)!;
  // Four places so re-saving lands on the same millicents.
  return trimAmount(centsPerUnit(ingredient.unitCostMillicents, unit) / 100, 4);
}

function UnitSelect({
  name,
  value,
  units,
  onChange,
  label,
}: {
  name: string;
  value: string;
  units: readonly UnitDef[];
  onChange: (unit: string) => void;
  label: string;
}) {
  return (
    <NativeSelect
      name={name}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      className="w-28 shrink-0"
    >
      {units.map((u) => (
        <NativeSelectOption key={u.name} value={u.name}>
          {u.name}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

let nextKey = 0;

export function IngredientForm({
  ingredient,
  unitLocked,
  storageAreas,
}: {
  ingredient?: IngredientFormValue;
  /** Stock history or recipe lines already read this ingredient in its base unit. */
  unitLocked: boolean;
  storageAreas: string[];
}) {
  const [state, formAction, pending] = useActionState<IngredientFormState, FormData>(
    saveIngredient,
    {},
  );
  const [baseUnit, setBaseUnit] = useState<BaseUnit>(ingredient?.baseUnit ?? "g");
  const [packs, setPacks] = useState<PackRow[]>(() =>
    (ingredient?.packs ?? []).map((p) => {
      const entry = asEntry(p.baseQtyMilli, ingredient!.baseUnit);
      return { key: nextKey++, name: p.name, count: "1", size: entry.qty, unit: entry.unit };
    }),
  );
  const [costUnit, setCostUnit] = useState(COST_DISPLAY_UNIT[ingredient?.baseUnit ?? "g"]);
  const low = asEntry(ingredient?.lowStockAtMilli ?? null, baseUnit);
  const out = asEntry(ingredient?.outAtMilli ?? null, baseUnit);
  const [lowUnit, setLowUnit] = useState(low.unit);
  const [outUnit, setOutUnit] = useState(out.unit);

  const packUnits: UnitDef[] = packs
    .filter((p) => p.name.trim())
    .map((p) => ({ name: p.name.trim(), baseQtyMilli: 1 }));
  const entryUnits = unitsFor(baseUnit, packUnits);

  function changeBaseUnit(next: BaseUnit) {
    setBaseUnit(next);
    setCostUnit(COST_DISPLAY_UNIT[next]);
    setLowUnit(ENTRY_UNIT[next]);
    setOutUnit(ENTRY_UNIT[next]);
    setPacks((rows) => rows.map((r) => ({ ...r, unit: ENTRY_UNIT[next] })));
  }

  const updatePack = (key: number, patch: Partial<PackRow>) =>
    setPacks((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <form
      className="max-w-xl"
      onSubmit={(e) => {
        // Submitting by hand keeps what was typed when the server sends back an error;
        // a form `action` would reset the uncontrolled fields.
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => formAction(fd));
      }}
    >
      {ingredient ? <input type="hidden" name="ingredientId" value={ingredient.id} /> : null}
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="ing-name">Name</FieldLabel>
          <Input
            id="ing-name"
            name="name"
            required
            maxLength={120}
            defaultValue={ingredient?.name ?? ""}
            placeholder="e.g. Whole-milk mozzarella"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="ing-base">Measured by</FieldLabel>
          {unitLocked ? <input type="hidden" name="baseUnit" value={baseUnit} /> : null}
          <NativeSelect
            id="ing-base"
            name={unitLocked ? undefined : "baseUnit"}
            value={baseUnit}
            disabled={unitLocked}
            onChange={(e) => changeBaseUnit(e.target.value as BaseUnit)}
            className="w-full"
          >
            {BASE_UNITS.map((b) => (
              <NativeSelectOption key={b} value={b}>
                {BASE_UNIT_LABEL[b]} ({UNITS[b].map((u) => u.name).join(", ")})
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {unitLocked ? (
            <FieldDescription>Fixed: it already has stock history or recipe lines.</FieldDescription>
          ) : null}
        </Field>

        <FieldSet>
          <FieldLegend variant="label">Packs</FieldLegend>
          <FieldDescription>
            How you buy it, e.g. a case of 4 × 5 lb. Packs can be used to enter the cost, counts and
            receipts.
          </FieldDescription>
          <div className="space-y-2">
            {packs.map((p) => (
              <div
                key={p.key}
                data-testid="pack-row"
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2"
              >
                <Input
                  name="packName"
                  value={p.name}
                  onChange={(e) => updatePack(p.key, { name: e.target.value })}
                  placeholder="case"
                  aria-label="Pack name"
                  className="w-24 flex-1"
                />
                <span className="text-sm text-muted-foreground">=</span>
                <Input
                  name="packCount"
                  type="number"
                  min="1"
                  step="any"
                  value={p.count}
                  onChange={(e) => updatePack(p.key, { count: e.target.value })}
                  aria-label="Units in the pack"
                  className="w-16 tabular-nums"
                />
                <span className="text-sm text-muted-foreground">×</span>
                <Input
                  name="packSize"
                  type="number"
                  min="0"
                  step="any"
                  value={p.size}
                  onChange={(e) => updatePack(p.key, { size: e.target.value })}
                  aria-label="Size of each unit"
                  className="w-20 tabular-nums"
                />
                <UnitSelect
                  name="packUnit"
                  label="Pack size unit"
                  value={p.unit}
                  units={UNITS[baseUnit]}
                  onChange={(unit) => updatePack(p.key, { unit })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${p.name || "pack"}`}
                  onClick={() => setPacks((rows) => rows.filter((r) => r.key !== p.key))}
                >
                  <X />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setPacks((rows) => [
                  ...rows,
                  { key: nextKey++, name: "", count: "1", size: "", unit: COST_DISPLAY_UNIT[baseUnit] },
                ])
              }
            >
              <Plus /> Add pack
            </Button>
          </div>
        </FieldSet>

        <Field>
          <FieldLabel htmlFor="ing-cost">Cost ($)</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              id="ing-cost"
              name="cost"
              type="number"
              min="0"
              step="any"
              defaultValue={initialCost(ingredient)}
              className="tabular-nums"
            />
            <span className="text-sm text-muted-foreground">per</span>
            <UnitSelect
              name="costUnit"
              label="Cost unit"
              value={costUnit}
              units={entryUnits}
              onChange={setCostUnit}
            />
          </div>
          <FieldDescription>What you pay, per any unit or pack.</FieldDescription>
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="ing-area">Storage area</FieldLabel>
            <Input
              id="ing-area"
              name="storageArea"
              list="storage-areas"
              maxLength={60}
              defaultValue={ingredient?.storageArea ?? "Walk-in"}
            />
            <datalist id="storage-areas">
              {storageAreas.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </Field>
          <Field>
            <FieldLabel htmlFor="ing-shelf">Shelf order</FieldLabel>
            <Input
              id="ing-shelf"
              name="shelfOrder"
              type="number"
              min="0"
              step="1"
              defaultValue={ingredient?.shelfOrder ?? 0}
              className="tabular-nums"
            />
            <FieldDescription>Count sheets list the area in this order.</FieldDescription>
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="ing-low">
              Low stock at <span className="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                id="ing-low"
                name="lowQty"
                type="number"
                min="0"
                step="any"
                defaultValue={low.qty}
                className="tabular-nums"
              />
              <UnitSelect name="lowUnit" label="Low stock unit" value={lowUnit} units={entryUnits} onChange={setLowUnit} />
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor="ing-out">
              86 at <span className="font-normal text-muted-foreground">(optional)</span>
            </FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                id="ing-out"
                name="outQty"
                type="number"
                min="0"
                step="any"
                defaultValue={out.qty}
                className="tabular-nums"
              />
              <UnitSelect name="outUnit" label="86 unit" value={outUnit} units={entryUnits} onChange={setOutUnit} />
            </div>
            <FieldDescription>At or below this, every item that uses it is 86’d.</FieldDescription>
          </Field>
        </div>

        <Field orientation="horizontal">
          <Checkbox id="ing-active" name="isActive" defaultChecked={ingredient?.isActive ?? true} />
          <FieldLabel htmlFor="ing-active" className="font-normal!">
            Active (counted, and can 86 items)
          </FieldLabel>
        </Field>

        {state.error ? <FieldError>{state.error}</FieldError> : null}

        <div className="flex items-center gap-3 border-t border-border pt-5">
          <Button type="submit" disabled={pending}>
            {ingredient ? "Save changes" : "Create ingredient"}
          </Button>
          <Link href="/admin/inventory/ingredients" className={buttonVariants({ variant: "outline" })}>
            Cancel
          </Link>
        </div>
      </FieldGroup>
    </form>
  );
}
