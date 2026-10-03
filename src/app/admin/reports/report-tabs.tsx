"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function ReportTabs({ tabs }: { tabs: { slug: string; title: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Reports" className="mt-3 -mx-4 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0">
      <div className="flex gap-4">
        {tabs.map((tab) => {
          const href = `/admin/reports/${tab.slug}`;
          const active = pathname === href;
          return (
            <Link
              key={tab.slug}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px border-b-2 py-2 text-sm whitespace-nowrap transition-colors",
                active
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.title}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
