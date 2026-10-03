"use client";

import Link from "next/link";
import { Minus, Plus, ShoppingBag } from "lucide-react";
import { useCart } from "@/components/cart-context";
import { formatCents } from "@/lib/money";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { PromoCodeField, QuoteTotals, useCheckoutQuote } from "@/components/store/promo-summary";
import { cn } from "@/lib/utils";

export function CartView() {
  const { lines, subtotalCents, updateQuantity, removeLine, removePromoCode, orderType, ready } = useCart();
  const { quote, error } = useCheckoutQuote(orderType);

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
              Your cart is empty
            </EmptyTitle>
            <EmptyDescription>
              Add something delicious from the menu to get started.
            </EmptyDescription>
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

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold tracking-tight">Your cart</h1>
      <ul className="mt-6 divide-y divide-border border-y border-border">
        {lines.map((line) => (
          <li key={line.key} className="flex gap-4 py-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-medium">{line.itemName}</span>
                <span className="text-sm font-medium tabular-nums">
                  {formatCents(line.unitPriceCents * line.quantity)}
                </span>
              </div>
              {line.modifiers.length > 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  {line.modifiers
                    .map((m) =>
                      m.priceDeltaCents
                        ? `${m.modifierName} (+${formatCents(m.priceDeltaCents)})`
                        : m.modifierName,
                    )
                    .join(" · ")}
                </p>
              ) : null}
              {line.notes ? (
                <p className="mt-1 text-sm italic text-muted-foreground">
                  “{line.notes}”
                </p>
              ) : null}
              <div className="mt-3 flex items-center gap-3">
                <div className="flex items-center rounded-lg border border-border">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Decrease quantity of ${line.itemName}`}
                    onClick={() => updateQuantity(line.key, line.quantity - 1)}
                  >
                    <Minus />
                  </Button>
                  <span className="w-7 text-center text-sm tabular-nums">
                    {line.quantity}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Increase quantity of ${line.itemName}`}
                    onClick={() =>
                      updateQuantity(line.key, Math.min(50, line.quantity + 1))
                    }
                  >
                    <Plus />
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeLine(line.key)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  Remove
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-6 space-y-4">
        <PromoCodeField quote={quote} />
        {quote ? (
          <QuoteTotals quote={quote} totalLabel="Total before tip" onRemoveCode={removePromoCode} />
        ) : (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="text-base font-semibold tabular-nums">
              {formatCents(subtotalCents)}
            </span>
          </div>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Delivery fee and tip are added at checkout.
        </p>
      </div>

      <Separator className="mt-6" />

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Link
          href="/checkout"
          className={cn(buttonVariants({ size: "lg" }), "h-11! sm:flex-1")}
        >
          Go to checkout
        </Link>
        <Link
          href="/"
          className={cn(
            buttonVariants({ variant: "outline", size: "lg" }),
            "h-11! px-5!",
          )}
        >
          Add more items
        </Link>
      </div>
    </div>
  );
}
