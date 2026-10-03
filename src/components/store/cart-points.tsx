"use client";

import { useEffect, useState } from "react";
import { Gift } from "lucide-react";
import { previewCheckout } from "@/app/(store)/actions";
import type { CartLine } from "@/components/cart-context";

export type CartLoyalty = {
  balance: number | null;
  nextReward: { name: string; cost: number } | null;
};

/** "This order earns ~N points", and for members, progress to the next reward. */
export function CartPoints({ lines, loyalty }: { lines: CartLine[]; loyalty: CartLoyalty }) {
  const [earn, setEarn] = useState<number | null>(null);
  const cartKey = JSON.stringify(lines.map((l) => [l.itemId, l.quantity, l.modifiers.map((m) => m.id)]));

  useEffect(() => {
    let stale = false;
    previewCheckout({
      orderType: "pickup",
      rewardId: null,
      lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, modifierIds: l.modifiers.map((m) => m.id) })),
    }).then((p) => {
      if (!stale && p.ok) setEarn(p.pointsEarned);
    });
    return () => {
      stale = true;
    };
    // cartKey stands in for `lines`, whose identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey]);

  if (earn === null) return null;
  const { balance, nextReward } = loyalty;
  const after = balance === null ? null : balance + earn;

  return (
    <div className="mt-4 rounded-xl border border-border p-4 text-sm" data-testid="cart-points">
      <p className="flex items-center gap-2 font-medium">
        <Gift className="size-4" aria-hidden />
        This order earns ~{earn.toLocaleString()} points
      </p>
      {after !== null && nextReward ? (
        <div className="mt-3 space-y-1.5">
          <div
            role="progressbar"
            aria-label={`Progress to ${nextReward.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(1, after / nextReward.cost) * 100)}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.max(2, Math.min(1, after / nextReward.cost) * 100)}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground" data-testid="cart-next-reward">
            {after >= nextReward.cost
              ? `This order gets you to ${nextReward.name}.`
              : `After this order: ${after.toLocaleString()} of ${nextReward.cost.toLocaleString()} points toward ${nextReward.name}.`}
          </p>
        </div>
      ) : null}
    </div>
  );
}
