"use client";

import { useEffect, useState } from "react";
import type { DayHours } from "@/db/schema";
import { isOpenNow } from "@/lib/hours";
import { cn } from "@/lib/utils";

/**
 * Open/closed pill computed on the client so it reflects the visitor's
 * local clock (informational — ordering is governed by the operator's
 * pause switch, not by hours).
 */
export function StoreStatusBanner({
  hours,
  acceptingOrders,
}: {
  hours: DayHours[] | null;
  acceptingOrders: boolean;
}) {
  const [open, setOpen] = useState<boolean | null>(null);

  // Deliberate post-mount computation: uses the viewer's local clock, which
  // must not run during SSR (server timezone would mismatch the client).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(isOpenNow(hours));
    const t = setInterval(() => setOpen(isOpenNow(hours)), 60_000);
    return () => clearInterval(t);
  }, [hours]);

  if (open === null) return null;

  const live = open && acceptingOrders;

  return (
    <span className="inline-flex items-center gap-1.5 font-medium">
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          live ? "bg-success" : "bg-destructive",
        )}
      />
      <span className={live ? "text-success" : "text-destructive"}>
        {!acceptingOrders ? "Ordering paused" : open ? "Open now" : "Closed now"}
      </span>
    </span>
  );
}
