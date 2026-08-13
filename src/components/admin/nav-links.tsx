"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin", label: "Orders", exact: true },
  { href: "/admin/menu", label: "Menu", exact: false },
  { href: "/admin/modifiers", label: "Modifiers", exact: false },
  { href: "/admin/settings", label: "Settings", exact: false },
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
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md text-sm transition-colors ${
              vertical ? "px-3 py-2" : "whitespace-nowrap px-3 py-1.5"
            } ${
              active
                ? "bg-surface font-medium text-foreground"
                : "text-muted hover:bg-surface hover:text-foreground"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
