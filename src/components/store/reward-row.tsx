import type { ReactNode } from "react";
import type { PublicReward } from "@/lib/loyalty";
import { cn } from "@/lib/utils";

export function ProgressBar({ fraction, label }: { fraction: number; label: string }) {
  const clamped = Math.min(1, Math.max(0, fraction));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className="h-2 overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, clamped * 100)}%` }} />
    </div>
  );
}

/**
 * One reward's name, note (the description unless the caller has something
 * more pressing to say), scheduled price increase, and cost and value.
 */
export function RewardSummary({ reward, note }: { reward: PublicReward; note?: ReactNode }) {
  const detail = note ?? reward.description;
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-4" data-testid={`reward-${reward.id}`}>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{reward.name}</span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
        {reward.increaseLabel ? (
          <span className="block text-xs text-warning" data-testid="price-increase">
            {reward.increaseLabel}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-right text-sm tabular-nums text-muted-foreground">
        {reward.cost.toLocaleString()} pts
        <span className="block text-xs">{reward.valueLabel}</span>
      </span>
    </div>
  );
}

/** How far a balance is from a reward. */
export function RewardProgress({ reward, balance }: { reward: PublicReward; balance: number }) {
  const ready = balance >= reward.cost;
  return (
    <>
      <ProgressBar fraction={balance / reward.cost} label={`Progress to ${reward.name}`} />
      <p className={cn("text-xs", ready ? "font-medium text-success" : "text-muted-foreground")}>
        {ready ? "Ready to redeem at checkout" : `${(reward.cost - balance).toLocaleString()} points to go`}
      </p>
    </>
  );
}
