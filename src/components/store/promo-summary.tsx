"use client";

import { useEffect, useState } from "react";
import { Tag, X } from "lucide-react";
import { useCart } from "@/components/cart-context";
import { previewCheckout, type QuoteView } from "@/app/(store)/actions";
import { formatCents } from "@/lib/money";
import { normalizeCode } from "@/lib/promo-code";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 300;

/**
 * The server's quote for the current cart, codes, order type and phone,
 * re-fetched (debounced) on every change. `pending` is true while the shown
 * quote is for an older cart, so callers can hold the order button.
 */
export function useCheckoutQuote(orderType: "pickup" | "delivery", phone = "") {
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
    lines: lines.map((l) => ({
      itemId: l.itemId,
      quantity: l.quantity,
      modifierIds: l.modifiers.map((m) => m.id),
      notes: l.notes,
    })),
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

/** Subtotal, each deal as its own line, fees, tax, optional tip, then nudges and the total. */
export function QuoteTotals({
  quote,
  tipCents,
  totalLabel = "Total",
}: {
  quote: QuoteView;
  tipCents?: number;
  totalLabel?: string;
}) {
  const { removePromoCode } = useCart();
  const shownReasons = new Set(quote.rejected.map((r) => r.reason));
  const nudges = quote.nudges.filter((n) => !shownReasons.has(n.message));
  return (
    <dl className="space-y-1.5 text-sm">
      <Row label="Subtotal" cents={quote.subtotalCents} />
      {quote.discounts.map((d) => (
        <div key={d.promotionId} className="flex justify-between gap-3" data-testid="discount-line">
          <dt className="min-w-0">
            <span className="flex items-center gap-1.5 font-medium text-success">
              <Tag className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{d.label}</span>
            </span>
            <span className="block text-xs text-muted-foreground">
              {d.code ? <span className="font-mono">{d.code}</span> : "Applied automatically"}
              {d.ends ? ` · ${d.ends}` : ""}
            </span>
          </dt>
          <dd className="flex shrink-0 items-start gap-1 tabular-nums text-success">
            −{formatCents(d.amountCents)}
            {d.code ? <RemoveCodeButton code={d.code} onRemove={removePromoCode} /> : null}
          </dd>
        </div>
      ))}
      {quote.deliveryFeeCents > 0 ? <Row label="Delivery fee" cents={quote.deliveryFeeCents} /> : null}
      {quote.taxCents > 0 ? <Row label="Tax" cents={quote.taxCents} /> : null}
      {tipCents ? <Row label="Tip" cents={tipCents} /> : null}
      {nudges.map((n) => (
        <p key={n.promotionId} className="rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium" data-testid="nudge">
          {n.message}
        </p>
      ))}
      <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
        <dt>{totalLabel}</dt>
        <dd className="tabular-nums" data-testid="quote-total">
          {formatCents(quote.totalBeforeTipCents + (tipCents ?? 0))}
        </dd>
      </div>
      {quote.discountCents > 0 ? (
        <p className="text-right text-xs font-medium text-success">
          You save {formatCents(quote.discountCents)}
        </p>
      ) : null}
    </dl>
  );
}

function Row({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{formatCents(cents)}</dd>
    </div>
  );
}
