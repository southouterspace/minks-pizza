"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { useCart } from "@/components/cart-context";
import { formatCents, taxFromBps } from "@/lib/money";
import { placeOrder } from "@/app/(store)/actions";

export type CheckoutConfig = {
  storeName: string;
  storePhone: string | null;
  acceptingOrders: boolean;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  pickupPrepMinutes: number;
  deliveryPrepMinutes: number;
  deliveryFeeCents: number;
  deliveryMinimumCents: number;
  taxRateBps: number;
};

const TIP_PRESETS = [0, 10, 15, 20];

export function CheckoutForm({ config }: { config: CheckoutConfig }) {
  const router = useRouter();
  const { lines, subtotalCents, clear, ready } = useCart();
  const [pending, startTransition] = useTransition();
  const submittedRef = useRef(false);

  const defaultType = config.pickupEnabled ? "pickup" : "delivery";
  const [orderType, setOrderType] = useState<"pickup" | "delivery">(defaultType);
  const [tipPercent, setTipPercent] = useState<number | "custom">(15);
  const [customTip, setCustomTip] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [zip, setZip] = useState("");
  const [orderNotes, setOrderNotes] = useState("");

  const tipCents = useMemo(() => {
    if (tipPercent === "custom") {
      const dollars = parseFloat(customTip);
      return Number.isFinite(dollars) && dollars > 0
        ? Math.round(dollars * 100)
        : 0;
    }
    return Math.round((subtotalCents * tipPercent) / 100);
  }, [tipPercent, customTip, subtotalCents]);

  const taxCents = taxFromBps(subtotalCents, config.taxRateBps);
  const deliveryFeeCents =
    orderType === "delivery" ? config.deliveryFeeCents : 0;
  const totalCents = subtotalCents + taxCents + deliveryFeeCents + tipCents;

  const belowMinimum =
    orderType === "delivery" && subtotalCents < config.deliveryMinimumCents;

  if (!ready) {
    return <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6" />;
  }

  if (lines.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-24 text-center sm:px-6">
        <h1 className="text-2xl font-bold tracking-tight">
          Nothing to check out
        </h1>
        <p className="mt-2 text-sm text-muted">Your cart is empty.</p>
        <Link
          href="/"
          className="mt-6 inline-flex h-10 items-center rounded-md bg-accent px-5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85"
        >
          Browse the menu
        </Link>
      </div>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Guard against double-taps / repeat submits producing duplicate tickets.
    if (pending || submittedRef.current) return;
    submittedRef.current = true;
    setError(null);
    startTransition(async () => {
      const result = await placeOrder({
        orderType,
        customerName: name,
        customerPhone: phone,
        customerEmail: email,
        addressLine1: address1,
        addressLine2: address2,
        city,
        zip,
        orderNotes,
        tipCents,
        lines: lines.map((l) => ({
          itemId: l.itemId,
          quantity: l.quantity,
          modifierIds: l.modifiers.map((m) => m.id),
          notes: l.notes,
        })),
      });
      if (result.ok) {
        clear();
        try {
          localStorage.setItem("minks-last-order", result.orderId);
        } catch {
          // ignore storage failures
        }
        router.push(`/order/${result.orderId}`);
      } else {
        submittedRef.current = false; // allow retry after a rejected order
        setError(result.error);
      }
    });
  };

  const inputClass =
    "h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-foreground";
  const labelClass = "mb-1.5 block text-sm font-medium";

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold tracking-tight">Checkout</h1>

      <form
        onSubmit={submit}
        className="mt-8 grid gap-10 lg:grid-cols-[1fr_360px]"
      >
        <div className="space-y-8">
          {/* Order type */}
          <section>
            <h2 className="text-sm font-semibold">Order type</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {(
                [
                  ["pickup", "Pickup", config.pickupEnabled, config.pickupPrepMinutes],
                  ["delivery", "Delivery", config.deliveryEnabled, config.deliveryPrepMinutes],
                ] as const
              ).map(([value, label, enabled, minutes]) => (
                <button
                  key={value}
                  type="button"
                  disabled={!enabled}
                  onClick={() => setOrderType(value)}
                  className={`flex h-14 flex-col items-center justify-center rounded-md border text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    orderType === value
                      ? "border-foreground bg-surface"
                      : "border-border hover:border-foreground/30"
                  }`}
                >
                  {label}
                  <span className="text-xs font-normal text-muted">
                    {enabled ? `Ready in ~${minutes} min` : "Unavailable"}
                  </span>
                </button>
              ))}
            </div>
            {orderType === "delivery" && config.deliveryMinimumCents > 0 ? (
              <p className="mt-2 text-xs text-muted">
                {formatCents(config.deliveryMinimumCents)} minimum ·{" "}
                {formatCents(config.deliveryFeeCents)} delivery fee
              </p>
            ) : null}
          </section>

          {/* Contact */}
          <section>
            <h2 className="text-sm font-semibold">Your details</h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="co-name" className={labelClass}>
                  Name
                </label>
                <input
                  id="co-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="co-phone" className={labelClass}>
                  Phone
                </label>
                <input
                  id="co-phone"
                  required
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  autoComplete="tel"
                  placeholder="(555) 555-0123"
                  className={inputClass}
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="co-email" className={labelClass}>
                  Email{" "}
                  <span className="font-normal text-faint">
                    (optional, for your receipt)
                  </span>
                </label>
                <input
                  id="co-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  className={inputClass}
                />
              </div>
            </div>
          </section>

          {/* Delivery address */}
          {orderType === "delivery" ? (
            <section>
              <h2 className="text-sm font-semibold">Delivery address</h2>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label htmlFor="co-addr1" className={labelClass}>
                    Street address
                  </label>
                  <input
                    id="co-addr1"
                    required
                    value={address1}
                    onChange={(e) => setAddress1(e.target.value)}
                    autoComplete="address-line1"
                    className={inputClass}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="co-addr2" className={labelClass}>
                    Apt / unit{" "}
                    <span className="font-normal text-faint">(optional)</span>
                  </label>
                  <input
                    id="co-addr2"
                    value={address2}
                    onChange={(e) => setAddress2(e.target.value)}
                    autoComplete="address-line2"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="co-city" className={labelClass}>
                    City
                  </label>
                  <input
                    id="co-city"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    autoComplete="address-level2"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="co-zip" className={labelClass}>
                    ZIP
                  </label>
                  <input
                    id="co-zip"
                    required
                    value={zip}
                    onChange={(e) => setZip(e.target.value)}
                    autoComplete="postal-code"
                    className={inputClass}
                  />
                </div>
              </div>
            </section>
          ) : null}

          {/* Tip */}
          <section>
            <h2 className="text-sm font-semibold">
              Add a tip{" "}
              <span className="font-normal text-faint">
                (100% goes to the team)
              </span>
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {TIP_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setTipPercent(p)}
                  className={`h-9 rounded-md border px-4 text-sm font-medium transition-colors ${
                    tipPercent === p
                      ? "border-foreground bg-surface"
                      : "border-border hover:border-foreground/30"
                  }`}
                >
                  {p === 0 ? "No tip" : `${p}%`}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setTipPercent("custom")}
                className={`h-9 rounded-md border px-4 text-sm font-medium transition-colors ${
                  tipPercent === "custom"
                    ? "border-foreground bg-surface"
                    : "border-border hover:border-foreground/30"
                }`}
              >
                Custom
              </button>
              {tipPercent === "custom" ? (
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">
                    $
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={customTip}
                    onChange={(e) => setCustomTip(e.target.value)}
                    aria-label="Custom tip amount in dollars"
                    className="h-9 w-28 rounded-md border border-border bg-background pl-7 pr-3 text-sm outline-none focus:border-foreground"
                  />
                </div>
              ) : null}
            </div>
          </section>

          {/* Notes */}
          <section>
            <label htmlFor="co-notes" className="text-sm font-semibold">
              Order notes{" "}
              <span className="font-normal text-faint">(optional)</span>
            </label>
            <textarea
              id="co-notes"
              value={orderNotes}
              onChange={(e) => setOrderNotes(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="Anything we should know?"
              className="mt-2 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint focus:border-foreground"
            />
          </section>
        </div>

        {/* Summary */}
        <aside className="h-fit rounded-lg border border-border p-5 lg:sticky lg:top-24">
          <h2 className="text-sm font-semibold">Order summary</h2>
          <ul className="mt-4 space-y-3 text-sm">
            {lines.map((line) => (
              <li key={line.key} className="flex justify-between gap-3">
                <span className="min-w-0">
                  <span className="tabular-nums text-muted">
                    {line.quantity}×
                  </span>{" "}
                  {line.itemName}
                  {line.modifiers.length > 0 ? (
                    <span className="block truncate text-xs text-faint">
                      {line.modifiers.map((m) => m.modifierName).join(", ")}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatCents(line.unitPriceCents * line.quantity)}
                </span>
              </li>
            ))}
          </ul>
          <dl className="mt-4 space-y-1.5 border-t border-border pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Subtotal</dt>
              <dd className="tabular-nums">{formatCents(subtotalCents)}</dd>
            </div>
            {taxCents > 0 ? (
              <div className="flex justify-between">
                <dt className="text-muted">Tax</dt>
                <dd className="tabular-nums">{formatCents(taxCents)}</dd>
              </div>
            ) : null}
            {deliveryFeeCents > 0 ? (
              <div className="flex justify-between">
                <dt className="text-muted">Delivery fee</dt>
                <dd className="tabular-nums">{formatCents(deliveryFeeCents)}</dd>
              </div>
            ) : null}
            {tipCents > 0 ? (
              <div className="flex justify-between">
                <dt className="text-muted">Tip</dt>
                <dd className="tabular-nums">{formatCents(tipCents)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatCents(totalCents)}</dd>
            </div>
          </dl>

          {belowMinimum ? (
            <p className="mt-4 text-sm text-warning">
              Delivery orders have a {formatCents(config.deliveryMinimumCents)}{" "}
              minimum. Add {formatCents(config.deliveryMinimumCents - subtotalCents)}{" "}
              more to your cart.
            </p>
          ) : null}
          {error ? <p className="mt-4 text-sm text-error">{error}</p> : null}

          <button
            type="submit"
            disabled={pending || belowMinimum || !config.acceptingOrders}
            className="mt-5 flex h-11 w-full items-center justify-center rounded-md bg-accent text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending
              ? "Placing order…"
              : !config.acceptingOrders
                ? "Ordering paused"
                : `Place ${orderType} order · ${formatCents(totalCents)}`}
          </button>
          <p className="mt-3 text-center text-xs text-faint">
            You&apos;ll pay at {orderType === "pickup" ? "pickup" : "the door"}.
            Online payment is coming soon.
          </p>
        </aside>
      </form>
    </div>
  );
}
