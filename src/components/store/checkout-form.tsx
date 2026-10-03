"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { ShoppingBag } from "lucide-react";
import { toCartLineInput, useCart } from "@/components/cart-context";
import { formatCents } from "@/lib/money";
import { placeOrder } from "@/app/(store)/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { PromoCodeField, QuoteTotals, useCheckoutQuote } from "@/components/store/promo-summary";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { LoyaltyPanel } from "@/components/store/checkout-loyalty";
import { describeChoice } from "@/lib/pricing";

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
  loyalty: {
    programName: string;
    member: { name: string | null; phone: string; pointsBalance: number } | null;
  } | null;
};

const TIP_PRESETS = [0, 10, 15, 20];

export function CheckoutForm({ config }: { config: CheckoutConfig }) {
  const router = useRouter();
  const { lines, subtotalCents: cartSubtotalCents, promoCodes, removePromoCode, orderType, setOrderType, clear, ready } =
    useCart();
  const [pending, startTransition] = useTransition();
  const submittedRef = useRef(false);

  const [tipPercent, setTipPercent] = useState<number | "custom">(15);
  const [customTip, setCustomTip] = useState("");
  const [error, setError] = useState<string | null>(null);

  const member = config.loyalty?.member ?? null;
  const [name, setName] = useState(member?.name ?? "");
  const [phone, setPhone] = useState(member?.phone ?? "");
  const [joinLoyalty, setJoinLoyalty] = useState(true);
  const [rewardId, setRewardId] = useState<number | null>(null);
  const [email, setEmail] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [zip, setZip] = useState("");
  const [orderNotes, setOrderNotes] = useState("");

  const { quote, error: quoteError, pending: quotePending, refresh } = useCheckoutQuote(orderType, {
    phone,
    rewardId,
    withRewards: member !== null,
  });
  // Tip presets stay a share of the pre-discount subtotal: staff did the full work.
  const subtotalCents = quote?.subtotalCents ?? cartSubtotalCents;

  const tipCents = useMemo(() => {
    if (tipPercent === "custom") {
      const dollars = parseFloat(customTip);
      return Number.isFinite(dollars) && dollars > 0
        ? Math.round(dollars * 100)
        : 0;
    }
    return Math.round((subtotalCents * tipPercent) / 100);
  }, [tipPercent, customTip, subtotalCents]);

  const totalCents = quote ? quote.totalBeforeTipCents + tipCents : null;
  const rewardError = quote?.loyalty?.rewardError ?? null;

  const belowMinimum =
    orderType === "delivery" && subtotalCents < config.deliveryMinimumCents;

  if (!ready) {
    return <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6" />;
  }

  if (lines.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-24 sm:px-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShoppingBag aria-hidden />
            </EmptyMedia>
            <EmptyTitle className="text-2xl! font-bold! tracking-tight">
              Nothing to check out
            </EmptyTitle>
            <EmptyDescription>Your cart is empty.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link
              href="/"
              className={cn(buttonVariants({ size: "lg" }), "h-10! px-5!")}
            >
              Browse the menu
            </Link>
          </EmptyContent>
        </Empty>
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
        promoCodes,
        expectedTotalCents: totalCents ?? undefined,
        joinLoyalty: config.loyalty && !member ? joinLoyalty : false,
        rewardId,
        lines: lines.map(toCartLineInput),
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
        refresh();
      }
    });
  };

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
                <Button
                  key={value}
                  type="button"
                  variant="outline"
                  disabled={!enabled}
                  aria-pressed={orderType === value}
                  onClick={() => setOrderType(value)}
                  className={cn(
                    "h-14! flex-col gap-0.5",
                    orderType === value && "border-foreground! bg-muted!",
                  )}
                >
                  {label}
                  <span className="text-xs font-normal text-muted-foreground">
                    {enabled ? `Ready in ~${minutes} min` : "Unavailable"}
                  </span>
                </Button>
              ))}
            </div>
            {orderType === "delivery" && config.deliveryMinimumCents > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {formatCents(config.deliveryMinimumCents)} minimum ·{" "}
                {formatCents(config.deliveryFeeCents)} delivery fee
              </p>
            ) : null}
          </section>

          {/* Contact */}
          <section>
            <h2 className="text-sm font-semibold">Your details</h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="co-name">Name</FieldLabel>
                <Input
                  id="co-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="co-phone">Phone</FieldLabel>
                <Input
                  id="co-phone"
                  required
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  autoComplete="tel"
                  placeholder="(555) 555-0123"
                />
              </Field>
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor="co-email">
                  Email{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional, for your receipt)
                  </span>
                </FieldLabel>
                <Input
                  id="co-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </Field>
            </div>
          </section>

          {/* Delivery address */}
          {orderType === "delivery" ? (
            <section>
              <h2 className="text-sm font-semibold">Delivery address</h2>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="co-addr1">Street address</FieldLabel>
                  <Input
                    id="co-addr1"
                    required
                    value={address1}
                    onChange={(e) => setAddress1(e.target.value)}
                    autoComplete="address-line1"
                  />
                </Field>
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="co-addr2">
                    Apt / unit{" "}
                    <span className="font-normal text-muted-foreground">
                      (optional)
                    </span>
                  </FieldLabel>
                  <Input
                    id="co-addr2"
                    value={address2}
                    onChange={(e) => setAddress2(e.target.value)}
                    autoComplete="address-line2"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="co-city">City</FieldLabel>
                  <Input
                    id="co-city"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    autoComplete="address-level2"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="co-zip">ZIP</FieldLabel>
                  <Input
                    id="co-zip"
                    required
                    value={zip}
                    onChange={(e) => setZip(e.target.value)}
                    autoComplete="postal-code"
                  />
                </Field>
              </div>
            </section>
          ) : null}

          {config.loyalty ? (
            <LoyaltyPanel
              programName={config.loyalty.programName}
              member={member}
              quote={quote}
              rewardId={rewardId}
              onRewardChange={setRewardId}
              joinLoyalty={joinLoyalty}
              onJoinChange={setJoinLoyalty}
            />
          ) : null}

          {/* Tip */}
          <section>
            <h2 className="text-sm font-semibold">
              Add a tip{" "}
              <span className="font-normal text-muted-foreground">
                (100% goes to the team)
              </span>
            </h2>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {TIP_PRESETS.map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant={tipPercent === p ? "default" : "outline"}
                  size="lg"
                  aria-pressed={tipPercent === p}
                  onClick={() => setTipPercent(p)}
                  className="px-4!"
                >
                  {p === 0 ? "No tip" : `${p}%`}
                </Button>
              ))}
              <Button
                type="button"
                variant={tipPercent === "custom" ? "default" : "outline"}
                size="lg"
                aria-pressed={tipPercent === "custom"}
                onClick={() => setTipPercent("custom")}
                className="px-4!"
              >
                Custom
              </Button>
              {tipPercent === "custom" ? (
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={customTip}
                    onChange={(e) => setCustomTip(e.target.value)}
                    aria-label="Custom tip amount in dollars"
                    className="h-9! w-28 pl-7!"
                  />
                </div>
              ) : null}
            </div>
            {quote && quote.discountCents > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Tip is based on your pre-discount subtotal.
              </p>
            ) : null}
          </section>

          {/* Notes */}
          <section>
            <Label htmlFor="co-notes" className="text-sm font-semibold">
              Order notes{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <Textarea
              id="co-notes"
              value={orderNotes}
              onChange={(e) => setOrderNotes(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="Anything we should know?"
              className="mt-2 resize-none"
            />
          </section>
        </div>

        {/* Summary */}
        <Card className="h-fit lg:sticky lg:top-24">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">
              Order summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm">
              {lines.map((line) => (
                <li key={line.key} className="flex justify-between gap-3">
                  <span className="min-w-0">
                    <span className="tabular-nums text-muted-foreground">
                      {line.quantity}×
                    </span>{" "}
                    {line.itemName}
                    {line.modifiers.length > 0 ? (
                      <span className="block text-xs text-muted-foreground">
                        {line.modifiers.map((m) => describeChoice(m)).join(", ")}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatCents(line.unitPriceCents * line.quantity)}
                  </span>
                </li>
              ))}
            </ul>

            <Separator className="my-4" />

            <div className="space-y-4">
              <PromoCodeField quote={quote} />
              {quote ? <QuoteTotals quote={quote} tipCents={tipCents} onRemoveCode={removePromoCode} /> : null}
              {quote?.loyalty?.pointsEarned ? (
                <p className="flex justify-between text-xs text-muted-foreground" data-testid="points-to-earn">
                  <span>Points you&apos;ll earn{quote.loyalty.promoName ? ` (${quote.loyalty.promoName})` : ""}</span>
                  <span className="tabular-nums">+{quote.loyalty.pointsEarned.toLocaleString()}</span>
                </p>
              ) : null}
            </div>

            {belowMinimum ? (
              <p className="mt-4 text-sm text-warning">
                Delivery orders have a {formatCents(config.deliveryMinimumCents)}{" "}
                minimum. Add{" "}
                {formatCents(config.deliveryMinimumCents - subtotalCents)} more
                to your cart.
              </p>
            ) : null}
            {rewardError ? (
              <p className="mt-4 text-sm text-destructive">{rewardError}</p>
            ) : null}
            {error || quoteError ? (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {error ?? quoteError}
              </p>
            ) : null}

            <Button
              type="submit"
              disabled={
                pending || quotePending || totalCents === null || belowMinimum || !config.acceptingOrders || rewardError !== null
              }
              className="mt-5 h-11! w-full"
              data-testid="place-order"
            >
              {pending
                ? "Placing order…"
                : !config.acceptingOrders
                  ? "Ordering paused"
                  : totalCents === null
                    ? "Updating total…"
                    : `Place ${orderType} order · ${formatCents(totalCents)}`}
            </Button>
            <p className="mt-3 text-center text-xs text-muted-foreground">
              You&apos;ll pay at {orderType === "pickup" ? "pickup" : "the door"}.
              Online payment is coming soon.
            </p>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}

