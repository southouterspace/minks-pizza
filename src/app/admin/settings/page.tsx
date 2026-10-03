import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db, storeSettings, type DayHours } from "@/db";
import { requireOperator } from "@/lib/auth";
import { DAY_NAMES, STORE_TIMEZONES } from "@/lib/hours";
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

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Settings" };

const DEFAULTS = {
  name: "My Pizzeria",
  tagline: null as string | null,
  logoUrl: null as string | null,
  logoUploadedAt: null as Date | null,
  phone: null as string | null,
  email: null as string | null,
  addressLine1: null as string | null,
  addressLine2: null as string | null,
  city: null as string | null,
  state: null as string | null,
  zip: null as string | null,
  hours: null as DayHours[] | null,
  pickupEnabled: true,
  deliveryEnabled: false,
  pickupPrepMinutes: 20,
  deliveryPrepMinutes: 45,
  kdsWarnMinutes: 10,
  kdsLateMinutes: 15,
  kdsOvenMinutes: 7,
  deliveryFeeCents: 0,
  deliveryMinimumCents: 0,
  taxRateBps: 0,
  timezone: "America/Chicago",
  halfToppingPriceBps: 5000,
  halfPortionBps: 5000,
  lightPortionBps: 5000,
  extraPortionBps: 15000,
  minMarginBps: 7000,
  isPublished: false,
  isAcceptingOrders: true,
};

const PERCENT_FIELDS = [
  {
    name: "halfToppingPricePct",
    key: "halfToppingPriceBps",
    label: "Half topping price",
    hint: "Share of a topping's price charged for a half.",
  },
  {
    name: "halfPortionPct",
    key: "halfPortionBps",
    label: "Half portion",
    hint: "Share of the topping a half uses.",
  },
  {
    name: "lightPortionPct",
    key: "lightPortionBps",
    label: "Light portion",
    hint: "Share of the topping light uses.",
  },
  {
    name: "extraPortionPct",
    key: "extraPortionBps",
    label: "Extra portion",
    hint: "Extra uses this much of the topping (100–300%).",
  },
  {
    name: "minMarginPct",
    key: "minMarginBps",
    label: "Minimum margin",
    hint: "Items below this gross margin are flagged.",
  },
] as const;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();
  const saved = (await searchParams).saved === "1";

  const [row] = await db
    .select()
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  const settings = row ?? DEFAULTS;

  const hoursByDay = new Map<number, DayHours>(
    (settings.hours ?? []).map((h) => [h.day, h]),
  );

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>

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
            Time zone
          </FieldLegend>
          <Field className="max-w-xs">
            <FieldLabel htmlFor="s-timezone">Store time zone</FieldLabel>
            <NativeSelect id="s-timezone" name="timezone" defaultValue={settings.timezone}>
              {STORE_TIMEZONES.map((tz) => (
                <NativeSelectOption key={tz.value} value={tz.value}>
                  {tz.label} ({tz.value})
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>
              Decides when the store&apos;s day starts for order stats, history
              dates and promised times.
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
            Toppings and margins
          </FieldLegend>
          <Card>
            <div className="grid gap-4 px-4 sm:grid-cols-2">
              {PERCENT_FIELDS.map((f) => (
                <Field key={f.name}>
                  <FieldLabel htmlFor={`s-${f.name}`}>{f.label} (%)</FieldLabel>
                  <Input
                    id={`s-${f.name}`}
                    name={f.name}
                    type="number"
                    min={f.key === "extraPortionBps" ? 100 : 0}
                    max={f.key === "extraPortionBps" ? 300 : 100}
                    step="0.01"
                    required
                    defaultValue={settings[f.key] / 100}
                    className="tabular-nums"
                  />
                  <FieldDescription>{f.hint}</FieldDescription>
                </Field>
              ))}
            </div>
          </Card>
        </FieldSet>

        <FieldSet className="min-w-0">
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
                  <div className="ml-auto flex flex-wrap items-center gap-2">
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
