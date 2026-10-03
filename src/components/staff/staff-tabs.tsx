"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/admin/staff", label: "Overview" },
  { href: "/admin/staff/schedule", label: "Schedule" },
  { href: "/admin/staff/timesheets", label: "Timesheets" },
  { href: "/admin/staff/employees", label: "Employees" },
  { href: "/admin/staff/time-off", label: "Time off" },
];

export function StaffTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Staff" className="flex gap-1 overflow-x-auto">
      {TABS.map((tab) => {
        const active =
          tab.href === "/admin/staff" ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors",
              active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
