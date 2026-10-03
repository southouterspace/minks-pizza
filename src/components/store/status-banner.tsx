"use client";

import { useEffect, useState } from "react";
import type { DayHours } from "@/db/schema";
import { isOpenNow } from "@/lib/hours";
import { cn } from "@/lib/utils";

/**
 * Open/closed pill on the store's clock, kept current on the client
 * (informational: ordering is governed by the operator's pause switch, not
 * by hours).
 */
export function StoreStatusBanner({
  hours,
  timeZone,
  acceptingOrders,
}: {
  hours: DayHours[] | null;
  timeZone: string;
  acceptingOrders: boolean;
}) {
  const [open, setOpen] = useState<boolean | null>(null);

  // Post-mount so the pill ticks with the viewer's session, not the render time.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(isOpenNow(hours, timeZone));
    const t = setInterval(() => setOpen(isOpenNow(hours, timeZone)), 60_000);
    return () => clearInterval(t);
  }, [hours, timeZone]);

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
