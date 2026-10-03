"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { PosMenu } from "@/lib/orders-server";
import type { MenuItem } from "@/lib/pricing";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";

export function MenuGrid({ menu, onPick }: { menu: PosMenu; onPick: (item: MenuItem) => void }) {
  const [categoryId, setCategoryId] = useState(menu.categories[0]?.id ?? 0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const closeSearch = () => {
    setQuery("");
    setSearching(false);
  };

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (searching) {
      return menu.categories.flatMap((c) => c.items).filter((i) => i.name.toLowerCase().includes(q));
    }
    return menu.categories.find((c) => c.id === categoryId)?.items ?? [];
  }, [menu, categoryId, query, searching]);

  // "/" or any letter typed outside a field jumps into search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [role=dialog]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/" || /^[a-z]$/i.test(e.key)) {
        // The first letter goes into the box that this keystroke opens.
        if (e.key !== "/") setQuery(e.key);
        setSearching(true);
        search.current?.focus();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        {searching ? (
          <label className="relative flex flex-1 items-center">
            <Search className="pointer-events-none absolute left-3 size-5 text-muted-foreground" />
            <input
              ref={search}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onBlur={() => !query && setSearching(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && items[0]) {
                  onPick(items[0]);
                  closeSearch();
                }
                if (e.key === "Escape") closeSearch();
              }}
              placeholder="Search the menu"
              aria-label="Search menu"
              className="h-13 w-full rounded-xl border bg-background pr-12 pl-10 text-lg outline-none focus:ring-3 focus:ring-ring/40"
            />
            <button type="button" className="absolute right-1 flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted" onClick={closeSearch} aria-label="Close search">
              <X className="size-5" />
            </button>
          </label>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto rounded-xl bg-muted p-1" role="tablist">
              {menu.categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={c.id === categoryId}
                  onClick={() => setCategoryId(c.id)}
                  className={cn("h-11 shrink-0 grow rounded-lg px-3 text-base font-medium whitespace-nowrap", c.id === categoryId ? "bg-background shadow-sm" : "text-muted-foreground")}
                >
                  {c.name}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setSearching(true)} className="flex size-13 shrink-0 items-center justify-center rounded-xl border hover:bg-muted" aria-label="Search menu (/)">
              <Search className="size-5" />
            </button>
          </>
        )}
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
