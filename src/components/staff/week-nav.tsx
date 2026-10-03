import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, formatDay, type LocalDate } from "@/lib/zoned";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Prev / this week / next links for a page that takes `?week=YYYY-MM-DD`. */
export function WeekNav({ path, weekStart, thisWeek }: { path: string; weekStart: LocalDate; thisWeek: LocalDate }) {
  const href = (week: LocalDate) => `${path}?week=${week}`;
  const button = buttonVariants({ variant: "outline", size: "sm" });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={href(addDays(weekStart, -7))} className={button} aria-label="Previous week">
        <ChevronLeft />
      </Link>
      <Link
        href={href(thisWeek)}
        className={cn(button, weekStart === thisWeek && "pointer-events-none opacity-50")}
        aria-disabled={weekStart === thisWeek}
      >
        This week
      </Link>
      <Link href={href(addDays(weekStart, 7))} className={button} aria-label="Next week">
        <ChevronRight />
      </Link>
      <span className="text-sm font-medium" data-testid="week-label">
        {formatDay(weekStart)} to {formatDay(addDays(weekStart, 6))}
      </span>
    </div>
  );
}
