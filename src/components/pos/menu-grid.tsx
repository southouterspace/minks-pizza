"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { PosMenu } from "@/lib/orders-server";
import type { MenuItem } from "@/lib/pricing";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";

/** Category tabs over a big item grid; typing anywhere searches the whole menu. */
export function MenuGrid({ menu, onPick }: { menu: PosMenu; onPick: (item: MenuItem) => void }) {
  const [categoryId, setCategoryId] = useState(menu.categories[0]?.id ?? 0);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      return menu.categories.flatMap((c) => c.items).filter((i) => i.name.toLowerCase().includes(q));
    }
    return menu.categories.find((c) => c.id === categoryId)?.items ?? [];
  }, [menu, categoryId, query]);

  // "/" or any letter typed outside a field jumps into search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [role=dialog]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/" || /^[a-z]$/i.test(e.key)) {
        search.current?.focus();
        if (e.key === "/") e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto rounded-xl bg-muted p-1" role="tablist">
          {menu.categories.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={!query && c.id === categoryId}
              onClick={() => {
                setCategoryId(c.id);
                setQuery("");
              }}
              className={cn(
                "h-11 shrink-0 rounded-lg px-4 text-base font-medium whitespace-nowrap",
                !query && c.id === categoryId ? "bg-background shadow-sm" : "text-muted-foreground",
              )}
            >
              {c.name}
            </button>
          ))}
        </div>
        <label className="relative flex h-13 w-52 shrink-0 items-center">
          <Search className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && items[0]) {
                onPick(items[0]);
                setQuery("");
              }
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Search  /"
            aria-label="Search menu"
            className="h-13 w-full rounded-xl border bg-background pr-9 pl-9 text-base outline-none focus:ring-3 focus:ring-ring/40"
          />
          {query && (
            <button type="button" className="absolute right-2 p-1 text-muted-foreground" onClick={() => setQuery("")} aria-label="Clear search">
              <X className="size-4" />
            </button>
          )}
        </label>
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-[6.5rem] grid-cols-3 content-start gap-3 overflow-y-auto pb-2 xl:grid-cols-4">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={!item.isAvailable}
            onClick={() => onPick(item)}
            data-item={item.name}
            className={cn(
              "flex flex-col justify-between rounded-2xl border bg-card p-3 text-left shadow-xs transition active:scale-[0.98]",
              item.isAvailable ? "hover:border-foreground/30" : "opacity-50",
            )}
          >
            <span className="line-clamp-2 text-base leading-snug font-semibold">{item.name}</span>
            <span className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{item.isAvailable ? formatCents(item.basePriceCents) : "86'd"}</span>
              {item.groups.length > 0 && <span className="text-xs">options</span>}
            </span>
          </button>
        ))}
        {items.length === 0 && <p className="col-span-full py-10 text-center text-muted-foreground">No items match “{query}”.</p>}
      </div>
    </div>
  );
}
