"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Polling refresher for the orders inbox: calls router.refresh() every
 * `intervalMs` and shows how fresh the data is.
 */
export function AutoRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let last = Date.now();
    const tick = setInterval(() => {
      if (Date.now() - last >= intervalMs) {
        last = Date.now();
        router.refresh();
      }
      setElapsed(Math.floor((Date.now() - last) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [router, intervalMs]);

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
      Live · updated {elapsed}s ago
    </span>
  );
}
