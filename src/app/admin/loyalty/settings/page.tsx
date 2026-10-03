import { requireOperator } from "@/lib/auth";
import { formatMultiplier } from "@/lib/loyalty";
import { getLoyaltySettings } from "@/lib/loyalty-server";
import { saveLoyaltySettings } from "../actions";
import { FormNotice } from "@/components/admin/form-notice";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

function NumberField({
  name,
  label,
  value,
  hint,
}: {
  name: string;
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={`ls-${name}`}>{label}</FieldLabel>
      <Input id={`ls-${name}`} name={name} type="number" min={0} step={1} required defaultValue={value} />
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

export default async function LoyaltySettingsPage({ searchParams }: PageProps<"/admin/loyalty/settings">) {
  await requireOperator();
  const sp = await searchParams;
  const s = await getLoyaltySettings();
  const tierRows = [...s.tiers, { name: "", minPoints: 0, multiplierBps: 10_000 }];

  return (
    <form action={saveLoyaltySettings} className="max-w-2xl space-y-8">
      <FormNotice saved={sp.saved ? "Program settings saved." : null} error={typeof sp.error === "string" ? sp.error : null} />

      <FieldSet>
        <FieldLegend className="w-full border-b border-border pb-2 text-sm!">Earning</FieldLegend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="ls-programName">Program name</FieldLabel>
            <Input id="ls-programName" name="programName" required maxLength={60} defaultValue={s.programName} />
          </Field>
          <NumberField
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
          <NumberField name="signupBonus" label="Welcome bonus" value={s.signupBonus} hint="Paid on the first completed order of $15 or more." />
          <NumberField name="birthdayPoints" label="Birthday points" value={s.birthdayPoints} hint="Once a year, for members who ordered in the last 12 months." />
          <NumberField name="referrerBonus" label="Referrer bonus" value={s.referrerBonus} hint="Up to 10 friends a year." />
          <NumberField name="refereeBonus" label="New friend bonus" value={s.refereeBonus} hint="Both pay on the friend's first completed order." />
        </div>
      </FieldSet>

      <FieldSet>
        <FieldLegend className="w-full border-b border-border pb-2 text-sm!">Expiration and time</FieldLegend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="ls-exp">Expire points after</FieldLabel>
            <Input
              id="ls-exp"
              name="expirationMonths"
              type="number"
              min={1}
              max={60}
              defaultValue={s.expirationMonths ?? ""}
              placeholder="Never"
            />
            <FieldDescription>Months without a completed order. Leave blank for never.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="ls-tz">Store timezone</FieldLabel>
            <Input id="ls-tz" name="timezone" required defaultValue={s.timezone} />
            <FieldDescription>Decides which day promotions and birthdays fall on.</FieldDescription>
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
              <Input name={`tier-name-${i}`} aria-label={`Tier ${i + 1} name`} defaultValue={t.name} placeholder="New tier" maxLength={40} />
              <Input
                name={`tier-min-${i}`}
                aria-label={`Tier ${i + 1} minimum points`}
                type="number"
                min={0}
                defaultValue={t.name ? t.minPoints : ""}
                placeholder="Points"
              />
              <Input
                name={`tier-multiplier-${i}`}
                aria-label={`Tier ${i + 1} multiplier`}
                type="number"
                min={1}
                step="0.05"
                defaultValue={t.multiplierBps / 10_000}
                title={formatMultiplier(t.multiplierBps)}
              />
            </div>
          ))}
          <p className="grid grid-cols-[1fr_100px_90px] gap-2 text-xs text-muted-foreground">
            <span>Name</span>
            <span>From points</span>
            <span>Multiplier</span>
          </p>
        </div>
      </FieldSet>

      <Button type="submit" className="h-10!">Save program settings</Button>
    </form>
  );
}
