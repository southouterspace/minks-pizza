import Link from "next/link";
import { ChevronRight, Gift } from "lucide-react";

/** The home page's pitch to signed-out visitors: what they'd earn, and the way in. */
export function RewardsStrip({
  programName,
  pointsPerDollar,
  signupBonus,
}: {
  programName: string;
  pointsPerDollar: number;
  signupBonus: number;
}) {
  return (
    <section aria-label={programName} className="border-b border-border">
      <Link
        href="/rewards"
        data-testid="rewards-strip"
        className="group mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 text-sm sm:px-6"
      >
        <Gift className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{programName}:</span>{" "}
          <span className="text-muted-foreground">
            earn {pointsPerDollar} points per $1 and trade them for free food.
            {signupBonus > 0 ? ` ${signupBonus.toLocaleString()} bonus points on your first order.` : ""}
          </span>
        </span>
        <span className="flex shrink-0 items-center font-medium underline-offset-4 group-hover:underline">
          Join free
          <ChevronRight className="size-4" aria-hidden />
        </span>
      </Link>
    </section>
  );
}
