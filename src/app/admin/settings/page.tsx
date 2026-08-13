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
import {
  centsToDollars,
  inputClass,
  labelClass,
  primaryButtonClass,
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Settings" };

const DEFAULTS = {
  name: "My Pizzeria",
  tagline: null as string | null,
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
  deliveryFeeCents: 0,
  deliveryMinimumCents: 0,
  taxRateBps: 0,
  isPublished: false,
  isAcceptingOrders: true,
};

function Switch({ on, label }: { on: boolean; label: string }) {
  return (
    <button
      type="submit"
      role="switch"
      aria-checked={on}
      className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${
        on ? "bg-success" : "bg-border"
      }`}
    >
      <span className="sr-only">{label}</span>
      <span
        aria-hidden="true"
        className={`absolute top-0.5 left-0 h-5 w-5 rounded-full border border-border bg-white transition-transform ${
          on ? "translate-x-[22px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="border-b border-border pb-2 text-sm font-semibold">
      {children}
    </h2>
  );
}

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
      <section className="mt-6 rounded-lg border border-border">
        <div className="flex items-start justify-between gap-4 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Publish store</h2>
            <p className="mt-1 text-sm text-muted">
              {settings.isPublished ? (
                <span className="font-medium text-success">
                  Your store is live.
                </span>
              ) : (
                <>
                  Your store is hidden — customers see a coming-soon page.
                </>
              )}
            </p>
          </div>
          <form action={togglePublished} className="pt-0.5">
            <Switch
              on={settings.isPublished}
              label={
                settings.isPublished ? "Unpublish store" : "Publish store"
              }
            />
          </form>
        </div>
        <div className="flex items-start justify-between gap-4 border-t border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Accepting orders</h2>
            <p className="mt-1 text-sm text-muted">
              Pause online ordering temporarily without unpublishing.
              {settings.isAcceptingOrders ? null : (
                <span className="block font-medium text-warning">
                  Online ordering is paused.
                </span>
              )}
            </p>
          </div>
          <form action={toggleAcceptingOrders} className="pt-0.5">
            <Switch
              on={settings.isAcceptingOrders}
              label={
                settings.isAcceptingOrders
                  ? "Pause online ordering"
                  : "Resume online ordering"
              }
            />
          </form>
        </div>
      </section>

      {/* Main settings form */}
      <form action={saveSettings} className="mt-8 max-w-2xl space-y-8">
        <section className="space-y-4">
          <SectionHeading>Store info</SectionHeading>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="s-name" className={labelClass}>
                Store name
              </label>
              <input
                id="s-name"
                name="name"
                type="text"
                required
                maxLength={120}
                defaultValue={settings.name}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="s-tagline" className={labelClass}>
                Tagline
              </label>
              <input
                id="s-tagline"
                name="tagline"
                type="text"
                maxLength={200}
                defaultValue={settings.tagline ?? ""}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="s-phone" className={labelClass}>
                Phone
              </label>
              <input
                id="s-phone"
                name="phone"
                type="tel"
                maxLength={25}
                defaultValue={settings.phone ?? ""}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="s-email" className={labelClass}>
                Email
              </label>
              <input
                id="s-email"
                name="email"
                type="email"
                maxLength={200}
                defaultValue={settings.email ?? ""}
                className={inputClass}
              />
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <SectionHeading>Address</SectionHeading>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="s-address1" className={labelClass}>
                Address line 1
              </label>
              <input
                id="s-address1"
                name="addressLine1"
                type="text"
                maxLength={200}
                defaultValue={settings.addressLine1 ?? ""}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="s-address2" className={labelClass}>
                Address line 2
              </label>
              <input
                id="s-address2"
                name="addressLine2"
                type="text"
                maxLength={200}
                defaultValue={settings.addressLine2 ?? ""}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="s-city" className={labelClass}>
                City
              </label>
              <input
                id="s-city"
                name="city"
                type="text"
                maxLength={100}
                defaultValue={settings.city ?? ""}
                className={inputClass}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="s-state" className={labelClass}>
                  State
                </label>
                <input
                  id="s-state"
                  name="state"
                  type="text"
                  maxLength={20}
                  defaultValue={settings.state ?? ""}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="s-zip" className={labelClass}>
                  ZIP
                </label>
                <input
                  id="s-zip"
                  name="zip"
                  type="text"
                  maxLength={20}
                  defaultValue={settings.zip ?? ""}
                  className={inputClass}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <SectionHeading>Taxes</SectionHeading>
          <div className="max-w-xs">
            <label htmlFor="s-tax" className={labelClass}>
              Sales tax rate (%)
            </label>
            <input
              id="s-tax"
              name="taxPercent"
              type="number"
              step="0.01"
              min="0"
              max="100"
              defaultValue={(settings.taxRateBps / 100).toFixed(2)}
              className={`${inputClass} tabular-nums`}
            />
            <p className="mt-1.5 text-xs text-faint">
              Applied to the order subtotal, e.g. 8.75 for 8.75%.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <SectionHeading>Ordering</SectionHeading>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3 rounded-lg border border-border p-4">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  name="pickupEnabled"
                  defaultChecked={settings.pickupEnabled}
                  className="h-4 w-4 accent-black"
                />
                Pickup enabled
              </label>
              <div>
                <label htmlFor="s-pickup-prep" className={labelClass}>
                  Pickup prep time (minutes)
                </label>
                <input
                  id="s-pickup-prep"
                  name="pickupPrepMinutes"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={settings.pickupPrepMinutes}
                  className={`${inputClass} tabular-nums`}
                />
              </div>
            </div>
            <div className="space-y-3 rounded-lg border border-border p-4">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  name="deliveryEnabled"
                  defaultChecked={settings.deliveryEnabled}
                  className="h-4 w-4 accent-black"
                />
                Delivery enabled
              </label>
              <div>
                <label htmlFor="s-delivery-prep" className={labelClass}>
                  Delivery prep time (minutes)
                </label>
                <input
                  id="s-delivery-prep"
                  name="deliveryPrepMinutes"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={settings.deliveryPrepMinutes}
                  className={`${inputClass} tabular-nums`}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="s-delivery-fee" className={labelClass}>
                    Delivery fee ($)
                  </label>
                  <input
                    id="s-delivery-fee"
                    name="deliveryFee"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={centsToDollars(settings.deliveryFeeCents)}
                    className={`${inputClass} tabular-nums`}
                  />
                </div>
                <div>
                  <label htmlFor="s-delivery-min" className={labelClass}>
                    Delivery minimum ($)
                  </label>
                  <input
                    id="s-delivery-min"
                    name="deliveryMinimum"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={centsToDollars(
                      settings.deliveryMinimumCents,
                    )}
                    className={`${inputClass} tabular-nums`}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <SectionHeading>Hours</SectionHeading>
          <div className="space-y-2">
            {DAY_NAMES.map((dayName, day) => {
              const dayHours = hoursByDay.get(day);
              return (
                <div
                  key={day}
                  className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2"
                >
                  <span className="w-24 text-sm font-medium">{dayName}</span>
                  <label className="flex items-center gap-2 text-sm text-muted">
                    <input
                      type="checkbox"
                      name={`closed-${day}`}
                      defaultChecked={dayHours?.closed ?? false}
                      className="h-4 w-4 accent-black"
                    />
                    Closed
                  </label>
                  <div className="ml-auto flex items-center gap-2">
                    <label
                      htmlFor={`open-${day}`}
                      className="text-xs text-faint"
                    >
                      Open
                    </label>
                    <input
                      id={`open-${day}`}
                      name={`open-${day}`}
                      type="time"
                      defaultValue={dayHours?.open ?? "11:00"}
                      className={`${inputClass} w-auto tabular-nums`}
                    />
                    <label
                      htmlFor={`close-${day}`}
                      className="text-xs text-faint"
                    >
                      Close
                    </label>
                    <input
                      id={`close-${day}`}
                      name={`close-${day}`}
                      type="time"
                      defaultValue={dayHours?.close ?? "21:00"}
                      className={`${inputClass} w-auto tabular-nums`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <div className="flex items-center gap-3 border-t border-border pt-5">
          <button type="submit" className={primaryButtonClass}>
            Save settings
          </button>
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
