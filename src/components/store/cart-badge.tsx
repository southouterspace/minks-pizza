"use client";

import Link from "next/link";
import { ShoppingCart } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { useCart } from "@/components/cart-context";
import { cn } from "@/lib/utils";

export function CartBadge() {
  const { itemCount, ready } = useCart();

  return (
    <Link
      href="/cart"
      className={cn(buttonVariants({ size: "lg" }), "ml-1 gap-2!")}
    >
      <ShoppingCart aria-hidden />
      Cart
      {ready && itemCount > 0 ? (
        <Badge
          variant="secondary"
          className="h-5 min-w-5 justify-center rounded-full px-1 tabular-nums"
        >
          {itemCount}
        </Badge>
      ) : null}
    </Link>
  );
}
