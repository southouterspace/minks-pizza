"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { WASTE_REASONS, WASTE_REASON_LABEL } from "@/lib/inventory-domain";
import { logWaste } from "@/app/admin/inventory/actions";
import type { EntryIngredient } from "@/app/admin/inventory/entry";
import { SubmitButton } from "@/components/admin/order-actions";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export function WasteForm({ ingredients }: { ingredients: EntryIngredient[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [ingredientId, setIngredientId] = useState(ingredients[0]?.id ?? 0);
  const ingredient = ingredients.find((i) => i.id === ingredientId);

  return (
    <form
      ref={formRef}
      action={async (fd) => {
        const result = await logWaste(fd);
        if (!result.ok) return void toast.error(result.error);
        toast.success(`Logged waste: ${fd.get("qty")} ${fd.get("unit")} ${ingredient?.name ?? ""}`);
        formRef.current?.reset();
        setIngredientId(ingredients[0]?.id ?? 0);
      }}
      className="grid gap-4 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end"
    >
      <Field>
        <FieldLabel htmlFor="waste-ingredient">Ingredient</FieldLabel>
        <NativeSelect
          id="waste-ingredient"
          name="ingredientId"
          value={ingredientId}
          onChange={(e) => setIngredientId(Number(e.target.value))}
          className="w-full"
        >
          {ingredients.map((i) => (
            <NativeSelectOption key={i.id} value={i.id}>
              {i.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <div className="flex items-end gap-2">
        <Field className="w-24">
          <FieldLabel htmlFor="waste-qty">Quantity</FieldLabel>
          <Input id="waste-qty" name="qty" inputMode="decimal" autoComplete="off" required />
        </Field>
        <Field className="w-24">
          <FieldLabel htmlFor="waste-unit">Unit</FieldLabel>
          <NativeSelect
            id="waste-unit"
            name="unit"
            key={ingredientId}
            defaultValue={ingredient?.defaultUnit}
            className="w-full"
          >
            {ingredient?.units.map((u) => (
              <NativeSelectOption key={u} value={u}>
                {u}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field className="sm:w-32">
        <FieldLabel htmlFor="waste-reason">Reason</FieldLabel>
        <NativeSelect id="waste-reason" name="reason" defaultValue="dropped" className="w-full">
          {WASTE_REASONS.map((r) => (
            <NativeSelectOption key={r} value={r}>
              {WASTE_REASON_LABEL[r]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <SubmitButton>Log waste</SubmitButton>
    </form>
  );
}
