"use client";

import Link from "next/link";
import { useCart } from "@/components/cart-context";
import { formatCents } from "@/lib/money";

export function CartView() {
  const { lines, subtotalCents, updateQuantity, removeLine, ready } = useCart();

  if (!ready) {
    return <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6" />;
  }

  if (lines.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-24 text-center sm:px-6">
        <h1 className="text-2xl font-bold tracking-tight">Your cart is empty</h1>
        <p className="mt-2 text-sm text-muted">
          Add something delicious from the menu to get started.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex h-10 items-center rounded-md bg-accent px-5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85"
        >
          Browse the menu
        </Link>
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
                <p className="mt-1 text-sm text-muted">
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
                <p className="mt-1 text-sm italic text-faint">“{line.notes}”</p>
              ) : null}
              <div className="mt-3 flex items-center gap-3">
                <div className="flex items-center rounded-md border border-border">
                  <button
                    type="button"
                    aria-label={`Decrease quantity of ${line.itemName}`}
                    onClick={() => updateQuantity(line.key, line.quantity - 1)}
                    className="h-8 w-8 text-muted transition-colors hover:text-foreground"
                  >
                    −
                  </button>
                  <span className="w-7 text-center text-sm tabular-nums">
                    {line.quantity}
                  </span>
                  <button
                    type="button"
                    aria-label={`Increase quantity of ${line.itemName}`}
                    onClick={() =>
                      updateQuantity(line.key, Math.min(50, line.quantity + 1))
                    }
                    className="h-8 w-8 text-muted transition-colors hover:text-foreground"
                  >
                    +
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => removeLine(line.key)}
                  className="text-sm text-muted underline-offset-2 transition-colors hover:text-error hover:underline"
                >
                  Remove
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex items-center justify-between text-sm">
        <span className="text-muted">Subtotal</span>
        <span className="text-base font-semibold tabular-nums">
          {formatCents(subtotalCents)}
        </span>
      </div>
      <p className="mt-1 text-xs text-faint">
        Tax, fees, and tip are calculated at checkout.
      </p>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Link
          href="/checkout"
          className="flex h-11 flex-1 items-center justify-center rounded-md bg-accent text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85"
        >
          Go to checkout
        </Link>
        <Link
          href="/"
          className="flex h-11 items-center justify-center rounded-md border border-border px-5 text-sm font-medium transition-colors hover:border-foreground/40"
        >
          Add more items
        </Link>
      </div>
    </div>
  );
}
