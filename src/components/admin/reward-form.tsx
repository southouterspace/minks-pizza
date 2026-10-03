"use client";

import { useState } from "react";
import { PRICE_PROTECTION_DAYS, type RewardEffect } from "@/lib/loyalty";
import { saveReward } from "@/app/admin/loyalty/actions";
import { centsToDollars } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export type RewardFormValue = {
  id: number;
  name: string;
  description: string | null;
  pointsCost: number;
  sortOrder: number;
  isActive: boolean;
  effect: RewardEffect;
  /** What customers pay today, which may be a protected older price. */
  price: { cost: number };
};

export function RewardForm({
  reward,
  categories,
  submitLabel,
}: {
  reward: RewardFormValue | null;
  categories: { id: number; name: string }[];
  submitLabel: string;
}) {
  const [kind, setKind] = useState<RewardEffect["kind"]>(reward?.effect.kind ?? "amount_off");
  const [cost, setCost] = useState(reward ? String(reward.pointsCost) : "");
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
    <form action={saveReward} className="space-y-4" data-testid={reward ? `reward-form-${reward.id}` : "reward-form-new"}>
      {reward ? <input type="hidden" name="id" value={reward.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
        <Field>
          <FieldLabel htmlFor={`${prefix}-name`}>Name</FieldLabel>
          <Input id={`${prefix}-name`} name="name" required maxLength={80} defaultValue={reward?.name} />
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
        </Field>
      </div>
      {costNote ? (
        <p className="text-sm text-warning" data-testid="price-note">
          {costNote}
        </p>
      ) : null}
      <Field>
        <FieldLabel htmlFor={`${prefix}-desc`}>Description</FieldLabel>
        <Input id={`${prefix}-desc`} name="description" maxLength={200} defaultValue={reward?.description ?? ""} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${prefix}-kind`}>What it does</FieldLabel>
          <NativeSelect
            id={`${prefix}-kind`}
            name="effectKind"
            value={kind}
            onChange={(e) => setKind(e.target.value as RewardEffect["kind"])}
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
              defaultValue={effect?.kind === "amount_off" ? centsToDollars(effect.amountOffCents) : ""}
            />
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
              defaultValue={effect?.kind === "free_item" ? centsToDollars(effect.maxValueCents) : ""}
            />
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
                  defaultChecked={effect?.kind === "free_item" && effect.categoryIds.includes(c.id)}
                />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <div className="flex flex-wrap items-center gap-5">
        <Field orientation="horizontal" className="w-auto!">
          <FieldLabel htmlFor={`${prefix}-sort`} className="whitespace-nowrap">Sort order</FieldLabel>
          <Input id={`${prefix}-sort`} name="sortOrder" type="number" min={0} className="w-20" defaultValue={reward?.sortOrder ?? 0} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="isActive" defaultChecked={reward?.isActive ?? true} />
          Active
        </label>
        <Button type="submit" className="ml-auto h-9!">{submitLabel}</Button>
      </div>
    </form>
  );
}
