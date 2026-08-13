"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/** Shows a "track your order" link if this browser recently placed one. */
export function RecentOrderLink() {
  const [orderId, setOrderId] = useState<string | null>(null);

  // Deliberate post-mount read: localStorage doesn't exist during SSR.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOrderId(localStorage.getItem("minks-last-order"));
    } catch {
      // storage unavailable
    }
  }, []);

  if (!orderId) return null;

  return (
    <Link
      href={`/order/${orderId}`}
      className="inline-flex items-center gap-1 text-sm font-medium text-link underline-offset-2 hover:underline"
    >
      Track your recent order →
    </Link>
  );
}
