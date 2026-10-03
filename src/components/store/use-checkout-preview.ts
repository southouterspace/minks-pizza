"use client";

import { useEffect, useState } from "react";
import { previewCheckout, type CheckoutPreview } from "@/app/(store)/actions";
import type { CartLine } from "@/components/cart-context";

export type PreviewQuote = Extract<CheckoutPreview, { ok: true }>;

export type PreviewState =
  /** `previous` is the last good quote, for the other inputs; only for hints that may lag. */
  | { status: "loading"; previous: PreviewQuote | null }
  | { status: "ok"; quote: PreviewQuote }
  | { status: "error"; error: string };

/**
 * The server's quote for this exact cart, order type and reward. A result
 * for any other inputs reads as loading, so a stale quote never shows.
 */
export function useCheckoutPreview(
  lines: CartLine[],
  orderType: "pickup" | "delivery",
  rewardId: number | null,
  { withRewards }: { withRewards: boolean },
): PreviewState {
  const input = {
    orderType,
    rewardId,
    withRewards,
    lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, modifierIds: l.modifiers.map((m) => m.id) })),
  };
  const key = JSON.stringify(input);
  const [result, setResult] = useState<{ key: string; state: PreviewState } | null>(null);
  const [previous, setPrevious] = useState<PreviewQuote | null>(null);

  useEffect(() => {
    if (input.lines.length === 0) return;
    let stale = false;
    previewCheckout(input).then(
      (p) => {
        if (stale) return;
        setResult({ key, state: p.ok ? { status: "ok", quote: p } : { status: "error", error: p.error } });
        if (p.ok) setPrevious(p);
      },
      () => {
        if (!stale) setResult({ key, state: { status: "error", error: "We couldn't price your cart. Check your connection." } });
      },
    );
    return () => {
      stale = true;
    };
    // `key` is `input` serialized; `input` itself is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return result?.key === key ? result.state : { status: "loading", previous };
}
