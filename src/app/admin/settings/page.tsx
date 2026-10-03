import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db, storeSettings, type DayHours } from "@/db";
import { requireOperator } from "@/lib/auth";
import { DAY_NAMES } from "@/lib/hours";
import {
  saveSettings,
  toggleAcceptingOrders,
  togglePublished,
} from "@/app/admin/actions";
import { ToggleSwitchForm } from "@/components/admin/toggle-switch-form";
import { LogoField } from "@/components/admin/logo-field";
import { centsToDollars } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { HalfToppingRule } from "@/lib/pricing";
import { POS_SETTING_LIMITS } from "@/lib/settings";
import { defaultSettings } from "@/lib/settings-server";
import { US_TIMEZONES } from "@/lib/store-time";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Settings" };

const HALF_RULES: { value: HalfToppingRule; label: string; example: string }[] = [
  {
    value: "average",
    label: "Average of the halves",
    example: "$2.00 topping on the left, $1.00 on the right charges $1.50.",
  },
  {
    value: "highest",
    label: "Higher half",
    example: "$2.00 topping on the left, $1.00 on the right charges $2.00.",
  },
];

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();
  const params = await searchParams;
  const saved = params.saved === "1";
  const error = typeof params.error === "string" ? params.error : null;

  const [row] = await db
    .select()
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  const settings = row ?? defaultSettings();

  const hoursByDay = new Map<number, DayHours>(
    (settings.hours ?? []).map((h) => [h.day, h]),
  );

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      {error ? (
        <p role="alert" className="mt-2 text-sm font-medium text-destructive">
          Not saved: {error}
        </p>
      ) : null}

      {/* Storefront controls */}
      <Card className="mt-6 gap-0! py-0!">
        <div className="flex items-start justify-between gap-4 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Publish store</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {settings.isPublished ? (
                <span className="font-medium text-success">
                  Your store is live.
                </span>
              ) : (
                <>Your store is hidden — customers see a coming-soon page.</>
              )}
            </p>
          </div>
          <ToggleSwitchForm
            action={togglePublished}
            checked={settings.isPublished}
            label={settings.isPublished ? "Unpublish store" : "Publish store"}
            className="pt-1"
          />
        </div>
        <div className="flex items-start justify-between gap-4 border-t border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Accepting orders</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Pause online ordering temporarily without unpublishing.
              {settings.isAcceptingOrders ? null : (
                <span className="block font-medium text-warning">
                  Online ordering is paused.
                </span>
              )}
            </p>
          </div>
          <ToggleSwitchForm
            action={toggleAcceptingOrders}
            checked={settings.isAcceptingOrders}
            label={
              settings.isAcceptingOrders
                ? "Pause online ordering"
                : "Resume online ordering"
            }
            className="pt-1"
          />
        </div>
      </Card>

      {/* Main settings form */}
      <form action={saveSettings} className="mt-8 max-w-2xl space-y-8">
        <FieldSet>
          <FieldLegend className="w-full border-b border-border pb-2 text-sm!">
            Store info
          </FieldLegend>
          <LogoField
            initialLogoUrl={settings.logoUrl}
            initialUploadedUrl={
              settings.logoUploadedAt
                ? `/api/logo?v=${settings.logoUploadedAt.getTime()}`
                : null
            }
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="s-name">Store name</FieldLabel>
              <Input
                id="s-name"
                name="name"
                type="text"
                required
                maxLength={120}
                defaultValue={settings.name}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="s-tagline">Tagline</FieldLabel>
              <Input
                id="s-tagline"
                name="tagline"
                type="text"
                maxLength={200}
                defaultValue={settings.tagline ?? ""}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="s-phone">Phone</FieldLabel>
              <Input
                id="s-phone"
                name="phone"
                type="tel"
                maxLength={25}
                defaultValue={settings.phone ?? ""}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="s-email">Email</FieldLabel>
              <Input
                id="s-email"
                name="email"
                type="email"
                maxLength={200}
                defaultValue={settings.email ?? ""}
              />
            </Field>
          </div>
        </FieldSet>

        <FieldSet>
          <FieldLegend className="w-full border-b border-border pb-2 text-sm!">
            Address
          </FieldLegend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="s-address1">Address line 1</FieldLabel>
              <Input
                id="s-address1"
                name="addressLine1"
                type="text"
                maxLength={200}
                defaultValue={settings.addressLine1 ?? ""}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="s-address2">Address line 2</FieldLabel>
              <Input
                id="s-address2"
                name="addressLine2"
                type="text"
                maxLength={200}
                defaultValue={settings.addressLine2 ?? ""}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="s-city">City</FieldLabel>
              <Input
                id="s-city"
                name="city"
                type="text"
                maxLength={100}
                defaultValue={settings.city ?? ""}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="s-state">State</FieldLabel>
                <Input
                  id="s-state"
                  name="state"
                  type="text"
                  maxLength={20}
                  defaultValue={settings.state ?? ""}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="s-zip">ZIP</FieldLabel>
                <Input
                  id="s-zip"
                  name="zip"
                  type="text"
                  maxLength={20}
                  defaultValue={settings.zip ?? ""}
                />
              </Field>
            </div>
          </div>
        </FieldSet>

        <FieldSet>
          <FieldLegend className="w-full border-b border-border pb-2 text-sm!">
            Taxes
          </FieldLegend>
          <Field className="max-w-xs">
            <FieldLabel htmlFor="s-tax">Sales tax rate (%)</FieldLabel>
            <Input
              id="s-tax"
              name="taxPercent"
              type="number"
              step="0.01"
              min="0"
              max="100"
              defaultValue={(settings.taxRateBps / 100).toFixed(2)}
              className="tabular-nums"
            />
            <FieldDescription>
              Applied to the order subtotal, e.g. 8.75 for 8.75%.
            </FieldDescription>
          </Field>
        </FieldSet>

        <FieldSet>
          <FieldLegend className="w-full border-b border-border pb-2 text-sm!">
            Ordering
          </FieldLegend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <FieldGroup className="px-4">
                <Field orientation="horizontal">
                  <Checkbox
                    id="s-pickup-enabled"
                    name="pickupEnabled"
                    defaultChecked={settings.pickupEnabled}
                  />
                  <FieldLabel htmlFor="s-pickup-enabled">
                    Pickup enabled
                  </FieldLabel>
                </Field>
                <Field>
                  <FieldLabel htmlFor="s-pickup-prep">
                    Pickup prep time (minutes)
                  </FieldLabel>
                  <Input
                    id="s-pickup-prep"
                    name="pickupPrepMinutes"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue={settings.pickupPrepMinutes}
                    className="tabular-nums"
                  />
                </Field>
              </FieldGroup>
            </Card>
            <Card>
              <FieldGroup className="px-4">
                <Field orientation="horizontal">
                  <Checkbox
                    id="s-delivery-enabled"
                    name="deliveryEnabled"
                    defaultChecked={settings.deliveryEnabled}
                  />
                  <FieldLabel htmlFor="s-delivery-enabled">
                    Delivery enabled
                  </FieldLabel>
                </Field>
                <Field>
                  <FieldLabel htmlFor="s-delivery-prep">
                    Delivery prep time (minutes)
                  </FieldLabel>
                  <Input
                    id="s-delivery-prep"
                    name="deliveryPrepMinutes"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue={settings.deliveryPrepMinutes}
                    className="tabular-nums"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel htmlFor="s-delivery-fee">
                      Delivery fee ($)
                    </FieldLabel>
                    <Input
                      id="s-delivery-fee"
                      name="deliveryFee"
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue={centsToDollars(settings.deliveryFeeCents)}
                      className="tabular-nums"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="s-delivery-min">
                      Delivery minimum ($)
                    </FieldLabel>
                    <Input
                      id="s-delivery-min"
                      name="deliveryMinimum"
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue={centsToDollars(
                        settings.deliveryMinimumCents,
                      )}
                      className="tabular-nums"
                    />
                  </Field>
                </div>
              </FieldGroup>
            </Card>
          </div>
        </FieldSet>

        <FieldSet>
          <FieldLegend className="w-full border-b border-border pb-2 text-sm!">
            Point of sale
          </FieldLegend>
          <Field>
            <FieldLabel>Half-and-half topping price</FieldLabel>
            <RadioGroup
              name="halfToppingRule"
              defaultValue={settings.halfToppingRule}
              className="grid gap-2 sm:grid-cols-2"
            >
              {HALF_RULES.map((rule) => (
                <label
                  key={rule.value}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 has-data-checked:border-primary"
                >
                  <RadioGroupItem value={rule.value} className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium">{rule.label}</span>
                    <span className="block text-xs text-muted-foreground">{rule.example}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="s-extra">Extra topping (× price)</FieldLabel>
              <Input
                id="s-extra"
                name="extraToppingMultiplier"
                type="number"
                {...POS_SETTING_LIMITS.extraToppingMultiplier}
                required
                defaultValue={settings.extraToppingBps / 10_000}
                className="tabular-nums"
              />
              <FieldDescription>2 = extra costs twice the topping.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="s-discount">Discount approval over ($)</FieldLabel>
              <Input
                id="s-discount"
                name="discountApproval"
                type="number"
                {...POS_SETTING_LIMITS.discountApprovalDollars}
                required
                defaultValue={centsToDollars(settings.discountApprovalCents)}
                className="tabular-nums"
              />
              <FieldDescription>Above this needs a manager.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="s-lock">Auto-lock after (seconds)</FieldLabel>
              <Input
                id="s-lock"
                name="posLockSeconds"
                type="number"
                {...POS_SETTING_LIMITS.posLockSeconds}
                required
                defaultValue={settings.posLockSeconds}
                className="tabular-nums"
              />
              <FieldDescription>Back to the PIN pad when idle.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="s-oven-cap">Oven capacity (pies)</FieldLabel>
              <Input
                id="s-oven-cap"
                name="ovenCapacityPies"
                type="number"
                {...POS_SETTING_LIMITS.ovenCapacityPies}
                required
                defaultValue={settings.ovenCapacityPies}
                className="tabular-nums"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="s-make">Make time per pie (min)</FieldLabel>
              <Input
                id="s-make"
                name="makeMinutes"
                type="number"
                {...POS_SETTING_LIMITS.makeMinutes}
                required
                defaultValue={settings.makeMinutes}
                className="tabular-nums"
              />
              <FieldDescription>With oven capacity, sets the quoted wait.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="s-timezone">Store timezone</FieldLabel>
              <NativeSelect id="s-timezone" name="timezone" defaultValue={settings.timezone} className="w-full">
                {(US_TIMEZONES.some((z) => z.tz === settings.timezone)
                  ? US_TIMEZONES
                  : [{ tz: settings.timezone, label: settings.timezone }, ...US_TIMEZONES]
                ).map((z) => (
                  <NativeSelectOption key={z.tz} value={z.tz}>
                    {z.label} ({z.tz.split("/").pop()?.replace("_", " ")})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>Where report days start and end.</FieldDescription>
            </Field>
          </div>
        </FieldSet>

        <FieldSet>
          <FieldLegend className="w-full border-b border-border pb-2 text-sm!">
            Kitchen display
          </FieldLegend>
          <Card>
            <div className="grid gap-4 px-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="s-kds-warn">Ticket turns amber at (min)</FieldLabel>
                <Input
                  id="s-kds-warn"
                  name="kdsWarnMinutes"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue={settings.kdsWarnMinutes}
                  className="tabular-nums"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="s-kds-late">Ticket turns red at (min)</FieldLabel>
                <Input
                  id="s-kds-late"
                  name="kdsLateMinutes"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue={settings.kdsLateMinutes}
                  className="tabular-nums"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="s-kds-oven">Oven bake time (min)</FieldLabel>
                <Input
                  id="s-kds-oven"
                  name="kdsOvenMinutes"
                  type="number"
                  min="1"
                  step="1"
                  defaultValue={settings.kdsOvenMinutes}
                  className="tabular-nums"
                />
              </Field>
            </div>
          </Card>
        </FieldSet>

        <FieldSet>
          <FieldLegend className="w-full border-b border-border pb-2 text-sm!">
            Hours
          </FieldLegend>
          <div className="space-y-2">
            {DAY_NAMES.map((dayName, day) => {
              const dayHours = hoursByDay.get(day);
              return (
                <div
                  key={day}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
                >
                  <span className="w-24 text-sm font-medium">{dayName}</span>
                  <Field orientation="horizontal" className="w-auto">
                    <Checkbox
                      id={`closed-${day}`}
                      name={`closed-${day}`}
                      defaultChecked={dayHours?.closed ?? false}
                    />
                    <FieldLabel
                      htmlFor={`closed-${day}`}
                      className="font-normal! text-muted-foreground"
                    >
                      Closed
                    </FieldLabel>
                  </Field>
                  <div className="ml-auto flex items-center gap-2">
                    <FieldLabel
                      htmlFor={`open-${day}`}
                      className="text-xs! font-normal! text-muted-foreground"
                    >
                      Open
                    </FieldLabel>
                    <Input
                      id={`open-${day}`}
                      name={`open-${day}`}
                      type="time"
                      defaultValue={dayHours?.open ?? "11:00"}
                      className="w-auto tabular-nums"
                    />
                    <FieldLabel
                      htmlFor={`close-${day}`}
                      className="text-xs! font-normal! text-muted-foreground"
                    >
                      Close
                    </FieldLabel>
                    <Input
                      id={`close-${day}`}
                      name={`close-${day}`}
                      type="time"
                      defaultValue={dayHours?.close ?? "21:00"}
                      className="w-auto tabular-nums"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </FieldSet>

        <div className="flex items-center gap-3 border-t border-border pt-5">
          <Button type="submit">Save settings</Button>

          {saved ? (
            <span className="text-sm font-medium text-success" role="status">
              Saved
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );
}
