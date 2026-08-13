"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Polls for status changes while an order is active. */
export function OrderAutoRefresh({ intervalMs = 12_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [router, intervalMs]);

  return null;
}
