"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/admin/loyalty", label: "Overview", exact: true },
  { href: "/admin/loyalty/members", label: "Members", exact: false },
  { href: "/admin/loyalty/rewards", label: "Rewards", exact: false },
  { href: "/admin/loyalty/promotions", label: "Promotions", exact: false },
  { href: "/admin/loyalty/settings", label: "Program settings", exact: false },
];

export function LoyaltyTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Loyalty" className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
      {TABS.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors",
              active
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
