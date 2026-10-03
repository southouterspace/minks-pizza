"use client";

import Link from "next/link";
import { Gift } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { RewardSummary } from "@/components/store/reward-row";
import type { QuoteView } from "@/app/(store)/actions";
import { cn } from "@/lib/utils";

/** Checkout's rewards section: join by phone as a guest, or pick a reward as a member. */
export function LoyaltyPanel({
  programName,
  member,
  quote,
  rewardId,
  onRewardChange,
  joinLoyalty,
  onJoinChange,
}: {
  programName: string;
  member: { pointsBalance: number } | null;
  /** The latest quote, possibly for the previous cart: rewards and points are hints here. */
  quote: QuoteView | null;
  rewardId: number | null;
  onRewardChange: (id: number | null) => void;
  joinLoyalty: boolean;
  onJoinChange: (join: boolean) => void;
}) {
  if (!member) {
    return (
      <section data-testid="loyalty-panel" className="rounded-xl border border-border p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Gift className="size-4" aria-hidden />
          {quote?.loyalty?.pointsEarned
            ? `Earn ${quote.loyalty.pointsEarned.toLocaleString()} points on this order`
            : programName}
        </h2>
        <label className="mt-3 flex items-start gap-2.5 text-sm">
          <Checkbox
            checked={joinLoyalty}
            onCheckedChange={(checked) => onJoinChange(checked === true)}
            aria-label={`Join ${programName} with my phone number`}
            className="mt-0.5"
          />
          <span>Join {programName} with my phone number</span>
        </label>
        <Link
          href="/rewards?next=/checkout"
          className="mt-3 inline-block text-sm font-medium underline underline-offset-4"
        >
          Sign in to use your points
        </Link>
      </section>
    );
  }

  return (
    <section data-testid="loyalty-panel">
      <h2 className="flex items-center justify-between gap-3 text-sm font-semibold">
        <span className="flex items-center gap-2">
          <Gift className="size-4" aria-hidden />
          {programName}
        </span>
        <span className="font-normal text-muted-foreground">
          {member.pointsBalance.toLocaleString()} points
        </span>
      </h2>
      <RadioGroup
        value={rewardId === null ? "none" : String(rewardId)}
        onValueChange={(v) => onRewardChange(v === "none" ? null : Number(v))}
        className="mt-3 gap-0! divide-y divide-border rounded-xl border border-border"
      >
        <label className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm">
          <RadioGroupItem value="none" />
          No reward this time
        </label>
        {(quote?.loyalty?.rewards ?? []).map(({ reward, fitsCart }) => {
          const short = reward.cost - member.pointsBalance;
          const disabled = short > 0 || !fitsCart;
          return (
            <label
              key={reward.id}
              className={cn(
                "flex items-center gap-3 px-4 py-3",
                disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
              )}
            >
              <RadioGroupItem value={String(reward.id)} disabled={disabled} />
              <RewardSummary
                reward={reward}
                note={
                  short > 0
                    ? `${short.toLocaleString()} more points`
                    : !fitsCart
                      ? `Add a qualifying item to use this${reward.description ? `: ${reward.description}` : ""}`
                      : undefined
                }
              />
            </label>
          );
        })}
      </RadioGroup>
    </section>
  );
}
