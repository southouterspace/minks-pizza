"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { toCartLineInput, useCart } from "@/components/cart-context";
import { previewCheckout, type QuoteView } from "@/app/(store)/actions";
import { normalizeCode } from "@/lib/promo-code";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TotalsList, type Totals } from "@/components/totals-list";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 300;

/**
 * The server's quote for the current cart, codes, order type, phone and
 * loyalty reward, re-fetched (debounced) on every change. `pending` is true
 * while the shown quote is for an older cart, so callers can hold the order
 * button. `withRewards` also lists a signed-in member's rewards.
 */
export function useCheckoutQuote(
  orderType: "pickup" | "delivery",
  { phone = "", rewardId = null, withRewards = false }: { phone?: string; rewardId?: number | null; withRewards?: boolean } = {},
) {
  const { lines, promoCodes, ready } = useCart();
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<{ key: string; quote: QuoteView | null; error: string | null }>({
    key: "",
    quote: null,
    error: null,
  });

  const key = JSON.stringify({
    orderType,
    customerPhone: phone,
    promoCodes,
    rewardId,
    withRewards,
    lines: lines.map(toCartLineInput),
  });

  useEffect(() => {
    if (!ready) return;
    let stale = false;
    const timer = setTimeout(async () => {
      const r = await previewCheckout(JSON.parse(key)).catch(() => ({ ok: false as const, error: "Couldn't price your cart. Check your connection." }));
      if (stale) return;
      setResult((prev) =>
        r.ok
          ? { key: `${key}#${nonce}`, quote: r.quote, error: null }
          : { key: `${key}#${nonce}`, quote: prev.quote, error: r.error },
      );
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [key, nonce, ready]);

  return {
    quote: result.quote,
    error: result.error,
    pending: !ready || result.key !== `${key}#${nonce}`,
    refresh: () => setNonce((n) => n + 1),
  };
}

/** Collapsed behind "Have a promo code?" until asked for or a code is already on the cart. */
export function PromoCodeField({ quote }: { quote: QuoteView | null }) {
  const { promoCodes, addPromoCode, removePromoCode } = useCart();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  if (!open && promoCodes.length === 0) {
    return (
      <Button
        type="button"
        variant="link"
        className="h-auto! px-0! text-sm"
        onClick={() => setOpen(true)}
      >
        Have a promo code?
      </Button>
    );
  }

  const applied = new Set(
    (quote?.discounts ?? []).flatMap((d) => (d.code ? [normalizeCode(d.code)] : [])),
  );
  const notApplied = promoCodes.filter((c) => !applied.has(normalizeCode(c)));

  const apply = () => {
    if (!draft.trim()) return;
    addPromoCode(draft);
    setDraft("");
  };

  return (
    <div className="space-y-2" data-testid="promo-field">
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
          }}
          placeholder="Promo code"
          aria-label="Promo code"
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={40}
          className="uppercase placeholder:normal-case"
        />
        <Button type="button" variant="outline" onClick={apply} disabled={!draft.trim()}>
          Apply
        </Button>
      </div>
      {notApplied.length > 0 ? (
        <ul className="space-y-1.5">
          {notApplied.map((code) => {
            const reason = quote?.rejected.find((r) => r.code === normalizeCode(code))?.reason;
            return (
              <li key={code} className="flex items-start justify-between gap-2 text-sm" data-testid="promo-rejected">
                <span className="min-w-0">
                  <span className="font-mono font-medium">{code}</span>
                  <span role="status" className={cn("block text-xs", reason ? "text-warning" : "text-muted-foreground")}>
                    {reason ?? "Checking…"}
                  </span>
                </span>
                <RemoveCodeButton code={code} onRemove={removePromoCode} />
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function RemoveCodeButton({ code, onRemove }: { code: string; onRemove: (code: string) => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={`Remove code ${code}`}
      onClick={() => onRemove(code)}
      className="shrink-0 text-muted-foreground"
    >
      <X />
    </Button>
  );
}

/** The live quote as totals; a code's line carries the × that takes it off the cart. */
export function quoteTotals(quote: QuoteView, tipCents: number, onRemoveCode: (code: string) => void): Totals {
  return {
    subtotalCents: quote.subtotalCents,
    discounts: quote.discounts.map((d) => ({
      key: d.key,
      label: d.label,
      amountCents: d.amountCents,
      detail: (
        <>
          {d.code ? <span className="font-mono">{d.code}</span> : d.kind === "loyalty" ? "Reward" : "Applied automatically"}
          {d.note ? ` · ${d.note}` : ""}
        </>
      ),
      action: d.code ? <RemoveCodeButton code={d.code} onRemove={onRemoveCode} /> : null,
    })),
    deliveryFeeCents: quote.deliveryFeeCents,
    taxCents: quote.taxCents,
    tipCents,
    totalCents: quote.totalBeforeTipCents + tipCents,
    discountCents: quote.discountCents,
  };
}

/** The quote's totals with nudges above the total; a nudge already shown as a code's reason is left out. */
export function QuoteTotals({
  quote,
  tipCents = 0,
  totalLabel,
  onRemoveCode,
}: {
  quote: QuoteView;
  tipCents?: number;
  totalLabel?: string;
  onRemoveCode: (code: string) => void;
}) {
  const shownReasons = new Set(quote.rejected.map((r) => r.reason));
  return (
    <TotalsList totals={quoteTotals(quote, tipCents, onRemoveCode)} audience="customer" totalLabel={totalLabel} saved="save">
      {quote.nudges
        .filter((n) => !shownReasons.has(n.message))
        .map((n) => (
          <p key={n.promotionId} className="rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium" data-testid="nudge">
            {n.message}
          </p>
        ))}
    </TotalsList>
  );
}
