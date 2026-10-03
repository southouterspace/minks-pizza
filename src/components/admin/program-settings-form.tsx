"use client";

import { saveLoyaltySettings } from "@/app/admin/loyalty/actions";
import { FieldMessage, FormStatus, useLoyaltyForm } from "@/components/admin/loyalty-form";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatMultiplier } from "@/lib/loyalty";
import type { LoyaltySettings } from "@/lib/loyalty-server";

type Form = ReturnType<typeof useLoyaltyForm>;

function NumberField({
  form,
  name,
  label,
  value,
  hint,
}: {
  form: Form;
  name: string;
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={`ls-${name}`}>{label}</FieldLabel>
      <Input id={`ls-${name}`} name={name} type="number" min={0} step={1} required defaultValue={form.text(name, value)} />
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      <FieldMessage message={form.error(name)} />
    </Field>
  );
}

export function ProgramSettingsForm({ settings: s }: { settings: LoyaltySettings }) {
  const form = useLoyaltyForm(saveLoyaltySettings);
  const { text, error } = form;
  const tierRows = [...s.tiers, { name: "", minPoints: 0, multiplierBps: 10_000 }];

  return (
    <form key={form.key} action={form.formAction} className="max-w-2xl space-y-8">
      <FieldSet>
        <FieldLegend className="w-full border-b border-border pb-2 text-sm!">Earning</FieldLegend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="ls-programName">Program name</FieldLabel>
            <Input id="ls-programName" name="programName" required maxLength={60} defaultValue={text("programName", s.programName)} />
            <FieldMessage message={error("programName")} />
          </Field>
          <NumberField
            form={form}
            name="pointsPerDollar"
            label="Points per $1"
            value={s.pointsPerDollar}
            hint="On the food subtotal after rewards. Never on tax, tip or delivery."
          />
        </div>
      </FieldSet>

      <FieldSet>
        <FieldLegend className="w-full border-b border-border pb-2 text-sm!">Bonuses</FieldLegend>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField form={form} name="signupBonus" label="Welcome bonus" value={s.signupBonus} hint="Paid on the first completed order of $15 or more." />
          <NumberField form={form} name="birthdayPoints" label="Birthday points" value={s.birthdayPoints} hint="Once a year, for members who ordered in the last 12 months." />
          <NumberField form={form} name="referrerBonus" label="Referrer bonus" value={s.referrerBonus} hint="Up to 10 friends a year." />
          <NumberField form={form} name="refereeBonus" label="New friend bonus" value={s.refereeBonus} hint="Both pay on the friend's first completed order." />
        </div>
      </FieldSet>

      <FieldSet>
        <FieldLegend className="w-full border-b border-border pb-2 text-sm!">Expiration</FieldLegend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="ls-exp">Expire points after</FieldLabel>
            <Input
              id="ls-exp"
              name="expirationMonths"
              type="number"
              min={1}
              max={60}
              defaultValue={text("expirationMonths", s.expirationMonths)}
              placeholder="Never"
            />
            <FieldDescription>Months without a completed order. Leave blank for never.</FieldDescription>
            <FieldMessage message={error("expirationMonths")} />
          </Field>
        </div>
      </FieldSet>

      <FieldSet>
        <FieldLegend className="w-full border-b border-border pb-2 text-sm!">Tiers</FieldLegend>
        <FieldDescription>
          Members move up by points earned on orders in the last 12 months. The first tier starts at 0. Fill in the
          blank row to add a tier; clear a name to remove one.
        </FieldDescription>
        <div className="space-y-3" data-testid="tiers-editor">
          {tierRows.map((t, i) => (
            <div key={i} className="grid grid-cols-[1fr_100px_90px] gap-2">
              <Input name={`tier-name-${i}`} aria-label={`Tier ${i + 1} name`} defaultValue={text(`tier-name-${i}`, t.name)} placeholder="New tier" maxLength={40} />
              <Input
                name={`tier-min-${i}`}
                aria-label={`Tier ${i + 1} minimum points`}
                type="number"
                min={0}
                defaultValue={text(`tier-min-${i}`, t.name ? t.minPoints : "")}
                placeholder="Points"
              />
              <Input
                name={`tier-multiplier-${i}`}
                aria-label={`Tier ${i + 1} multiplier`}
                type="number"
                min={1}
                step="0.05"
                defaultValue={text(`tier-multiplier-${i}`, t.multiplierBps / 10_000)}
                title={formatMultiplier(t.multiplierBps)}
              />
              <div className="col-span-3 empty:hidden">
                <FieldMessage message={error(`tier-min-${i}`) ?? error(`tier-multiplier-${i}`) ?? error(`tier-name-${i}`)} />
              </div>
            </div>
          ))}
          <p className="grid grid-cols-[1fr_100px_90px] gap-2 text-xs text-muted-foreground">
            <span>Name</span>
            <span>From points</span>
            <span>Multiplier</span>
          </p>
        </div>
      </FieldSet>

      <div className="space-y-3">
        <FormStatus state={form.state} />
        <Button type="submit" className="h-10!" disabled={form.pending}>Save program settings</Button>
      </div>
    </form>
  );
}
