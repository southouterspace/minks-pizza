"use client";

import { Gift } from "lucide-react";
import type { CartLine } from "@/components/cart-context";
import { ProgressBar } from "@/components/store/reward-row";
import { useCheckoutPreview } from "@/components/store/use-checkout-preview";

export type CartLoyalty = {
  balance: number | null;
  nextReward: { name: string; cost: number } | null;
};

/** "This order earns ~N points", and for members, progress to the next reward. */
export function CartPoints({ lines, loyalty }: { lines: CartLine[]; loyalty: CartLoyalty }) {
  const preview = useCheckoutPreview(lines, "pickup", null, { withRewards: false });
  const quote = preview.status === "ok" ? preview.quote : preview.status === "loading" ? preview.previous : null;
  const earn = quote?.pointsEarned ?? null;

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
          <ProgressBar fraction={after / nextReward.cost} label={`Progress to ${nextReward.name}`} />
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
