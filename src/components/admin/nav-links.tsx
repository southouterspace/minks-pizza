"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarClock,
  ClipboardList,
  Settings,
  SlidersHorizontal,
  Users,
  UtensilsCrossed,
} from "lucide-react";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/admin", label: "Orders", exact: true, icon: ClipboardList },
  { href: "/admin/menu", label: "Menu", exact: false, icon: UtensilsCrossed },
  {
    href: "/admin/modifiers",
    label: "Modifiers",
    exact: false,
    icon: SlidersHorizontal,
  },
  { href: "/admin/staff", label: "Staff", exact: false, icon: CalendarClock },
  { href: "/admin/settings", label: "Settings", exact: false, icon: Settings },
  { href: "/admin/team", label: "Team", exact: false, icon: Users },
];

export function AdminNavLinks({
  orientation,
}: {
  orientation: "vertical" | "horizontal";
}) {
  const pathname = usePathname();
  const vertical = orientation === "vertical";

  return (
    <nav
      aria-label="Admin"
      className={
        vertical ? "flex flex-col gap-0.5" : "flex items-center gap-1"
      }
    >
      {LINKS.map((link) => {
        const active = link.exact
          ? pathname === link.href
          : pathname === link.href || pathname.startsWith(`${link.href}/`);
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-lg text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
              vertical ? "px-3 py-2" : "whitespace-nowrap px-2.5 py-1.5",
              active
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon aria-hidden="true" />
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
