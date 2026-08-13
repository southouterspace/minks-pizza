"use client";

import Link from "next/link";
import { useCart } from "@/components/cart-context";

export function CartBadge() {
  const { itemCount, ready } = useCart();

  return (
    <Link
      href="/cart"
      className="relative ml-1 flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="8" cy="21" r="1" />
        <circle cx="19" cy="21" r="1" />
        <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
      </svg>
      Cart
      {ready && itemCount > 0 ? (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-background px-1 text-xs font-semibold text-foreground">
          {itemCount}
        </span>
      ) : null}
    </Link>
  );
}
