"use client";

import { useState } from "react";
import { PRICE_PROTECTION_DAYS } from "@/lib/loyalty";
import type { LoyaltyReward } from "@/lib/loyalty-server";
import { saveReward } from "@/app/admin/loyalty/actions";
import { centsToDollars } from "@/lib/money";
import { FieldMessage, FormStatus, useLoyaltyForm } from "@/components/admin/loyalty-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export type RewardFormValue = Pick<
  LoyaltyReward,
  "id" | "name" | "description" | "pointsCost" | "sortOrder" | "isActive" | "effect" | "price"
>;

export function RewardForm(props: {
  reward: RewardFormValue | null;
  categories: { id: number; name: string }[];
  submitLabel: string;
}) {
  const form = useLoyaltyForm(saveReward);
  return <RewardFields key={form.key} form={form} {...props} />;
}

function RewardFields({
  form,
  reward,
  categories,
  submitLabel,
}: {
  form: ReturnType<typeof useLoyaltyForm>;
  reward: RewardFormValue | null;
  categories: { id: number; name: string }[];
  submitLabel: string;
}) {
  const { text, checked, error } = form;
  const [kind, setKind] = useState(text("effectKind", reward?.effect.kind ?? "amount_off"));
  const [cost, setCost] = useState(text("pointsCost", reward?.pointsCost));
  const newCost = Number.parseInt(cost, 10);
  const today = reward?.price.cost;
  const costNote =
    today === undefined || !Number.isInteger(newCost) || newCost === reward?.pointsCost
      ? null
      : newCost > today
        ? `Customers keep paying ${today.toLocaleString()} points for ${PRICE_PROTECTION_DAYS} days after you save, then ${newCost.toLocaleString()}.`
        : "Lower prices apply right away.";
  const effect = reward?.effect;
  const prefix = reward ? `r${reward.id}` : "new";

  return (
    <form action={form.formAction} className="space-y-4" data-testid={reward ? `reward-form-${reward.id}` : "reward-form-new"}>
      {reward ? <input type="hidden" name="id" value={reward.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
        <Field>
          <FieldLabel htmlFor={`${prefix}-name`}>Name</FieldLabel>
          <Input id={`${prefix}-name`} name="name" required maxLength={80} defaultValue={text("name", reward?.name)} />
          <FieldMessage message={error("name")} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${prefix}-cost`}>Points</FieldLabel>
          <Input
            id={`${prefix}-cost`}
            name="pointsCost"
            type="number"
            min={1}
            required
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
          <FieldMessage message={error("pointsCost")} />
        </Field>
      </div>
      {costNote ? (
        <p className="text-sm text-warning" data-testid="price-note">
          {costNote}
        </p>
      ) : null}
      <Field>
        <FieldLabel htmlFor={`${prefix}-desc`}>Description</FieldLabel>
        <Input id={`${prefix}-desc`} name="description" maxLength={200} defaultValue={text("description", reward?.description)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${prefix}-kind`}>What it does</FieldLabel>
          <NativeSelect
            id={`${prefix}-kind`}
            name="effectKind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="w-full"
          >
            <NativeSelectOption value="amount_off">Dollars off the order</NativeSelectOption>
            <NativeSelectOption value="free_item">A free item</NativeSelectOption>
          </NativeSelect>
        </Field>
        {kind === "amount_off" ? (
          <Field>
            <FieldLabel htmlFor={`${prefix}-off`}>Amount off ($)</FieldLabel>
            <Input
              id={`${prefix}-off`}
              name="amountOff"
              type="number"
              min="0.01"
              step="0.01"
              required
              defaultValue={text("amountOff", effect?.kind === "amount_off" ? centsToDollars(effect.amountOffCents) : "")}
            />
            <FieldMessage message={error("amountOff")} />
          </Field>
        ) : (
          <Field>
            <FieldLabel htmlFor={`${prefix}-max`}>Up to ($)</FieldLabel>
            <Input
              id={`${prefix}-max`}
              name="maxValue"
              type="number"
              min="0.01"
              step="0.01"
              required
              defaultValue={text("maxValue", effect?.kind === "free_item" ? centsToDollars(effect.maxValueCents) : "")}
            />
            <FieldMessage message={error("maxValue")} />
          </Field>
        )}
      </div>
      {kind === "free_item" ? (
        <fieldset>
          <legend className="text-sm font-medium">Any item from</legend>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            {categories.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  name="categoryIds"
                  value={String(c.id)}
                  defaultChecked={checked(
                    "categoryIds",
                    effect?.kind === "free_item" && effect.categoryIds.includes(c.id),
                    String(c.id),
                  )}
                />
                {c.name}
              </label>
            ))}
          </div>
          <FieldMessage message={error("categoryIds")} />
        </fieldset>
      ) : null}
      <div className="flex flex-wrap items-center gap-5">
        <Field orientation="horizontal" className="w-auto!">
          <FieldLabel htmlFor={`${prefix}-sort`} className="whitespace-nowrap">Sort order</FieldLabel>
          <Input id={`${prefix}-sort`} name="sortOrder" type="number" min={0} className="w-20" defaultValue={text("sortOrder", reward?.sortOrder ?? 0)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="isActive" defaultChecked={checked("isActive", reward?.isActive ?? true)} />
          Active
        </label>
        <Button type="submit" className="ml-auto h-9!" disabled={form.pending}>{submitLabel}</Button>
      </div>
      <FormStatus state={form.state} />
    </form>
  );
}
