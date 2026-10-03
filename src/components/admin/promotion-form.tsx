"use client";

import type { loyaltyPromotions } from "@/db/schema";
import { savePromotion } from "@/app/admin/loyalty/actions";
import { FieldMessage, FormStatus, useLoyaltyForm } from "@/components/admin/loyalty-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { formatMultiplier } from "@/lib/loyalty";
import { DAY_NAMES } from "@/lib/zoned";

type LoyaltyPromotion = typeof loyaltyPromotions.$inferSelect;

const MULTIPLIERS = [12_500, 15_000, 20_000, 30_000];

export type Promo = Pick<LoyaltyPromotion, "id" | "name" | "multiplierBps" | "daysOfWeek" | "startsOn" | "endsOn" | "isActive">;

export function PromotionForm({ promo }: { promo: Promo | null }) {
  const form = useLoyaltyForm(savePromotion);
  const { text, checked, error } = form;
  const prefix = promo ? `p${promo.id}` : "new";
  return (
    <form key={form.key} action={form.formAction} className="space-y-4" data-testid={promo ? `promo-form-${promo.id}` : "promo-form-new"}>
      {promo ? <input type="hidden" name="id" value={promo.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <Field>
          <FieldLabel htmlFor={`${prefix}-name`}>Name</FieldLabel>
          <Input id={`${prefix}-name`} name="name" required maxLength={80} defaultValue={text("name", promo?.name)} placeholder="Double points Tuesdays" />
          <FieldMessage message={error("name")} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${prefix}-mult`}>Points</FieldLabel>
          <NativeSelect id={`${prefix}-mult`} name="multiplier" defaultValue={text("multiplier", (promo?.multiplierBps ?? 20_000) / 10_000)} className="w-full">
            {MULTIPLIERS.map((bps) => (
              <NativeSelectOption key={bps} value={String(bps / 10_000)}>
                {formatMultiplier(bps)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldMessage message={error("multiplier")} />
        </Field>
      </div>
      <fieldset>
        <legend className="text-sm font-medium">
          Days <span className="font-normal text-muted-foreground">(none checked = every day)</span>
        </legend>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {DAY_NAMES.map((day, i) => (
            <label key={day} className="flex items-center gap-2 text-sm">
              <Checkbox name="daysOfWeek" value={String(i)} defaultChecked={checked("daysOfWeek", promo?.daysOfWeek.includes(i) ?? false, String(i))} />
              {day.slice(0, 3)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${prefix}-start`}>Starts <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
          <Input id={`${prefix}-start`} name="startsOn" type="date" defaultValue={text("startsOn", promo?.startsOn)} />
          <FieldMessage message={error("startsOn")} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${prefix}-end`}>Ends <span className="font-normal text-muted-foreground">(optional, inclusive)</span></FieldLabel>
          <Input id={`${prefix}-end`} name="endsOn" type="date" defaultValue={text("endsOn", promo?.endsOn)} />
          <FieldMessage message={error("endsOn")} />
        </Field>
      </div>
      <div className="flex items-center gap-5">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="isActive" defaultChecked={checked("isActive", promo?.isActive ?? true)} />
          Active
        </label>
        <Button type="submit" className="ml-auto h-9!" disabled={form.pending}>{promo ? "Save" : "Add promotion"}</Button>
      </div>
      <FormStatus state={form.state} />
    </form>
  );
}
