"use client";

import { Copy, Tag } from "lucide-react";
import type { AdvertisedDeal } from "@/lib/promotion-queries";
import { announceCodeAdded, useCart } from "@/components/cart-context";
import { Button } from "@/components/ui/button";

export function DealsStrip({ deals }: { deals: AdvertisedDeal[] }) {
  const { addPromoCode } = useCart();
  if (deals.length === 0) return null;
  return (
    <section aria-label="Deals" className="border-b border-border">
      <ul className="mx-auto flex max-w-5xl snap-x gap-3 overflow-x-auto px-4 py-4 sm:px-6">
        {deals.map((d) => (
          <li
            key={d.id}
            className="flex w-72 shrink-0 snap-start flex-col gap-1.5 rounded-xl border border-border p-3.5 text-sm"
            data-testid="deal"
          >
            <p className="flex items-center gap-1.5 font-semibold">
              <Tag className="size-3.5 shrink-0 text-success" aria-hidden />
              {d.name}
            </p>
            <p className="text-xs text-muted-foreground">{d.terms}</p>
            <div className="mt-auto flex items-center justify-between gap-2 pt-1">
              {d.code ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="font-mono"
                  aria-label={`Copy code ${d.code} and add it to your cart`}
                  onClick={() => {
                    addPromoCode(d.code!);
                    navigator.clipboard?.writeText(d.code!).catch(() => {});
                    announceCodeAdded(d.code!);
                  }}
                >
                  {d.code}
                  <Copy data-icon="inline-end" />
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">Applied automatically</span>
              )}
              {d.ends ? <span className="text-xs text-muted-foreground">{d.ends}</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
