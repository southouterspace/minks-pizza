"use client";

import { useState } from "react";
import type { CategoryView, MenuItemView } from "@/lib/menu";
import { formatCents } from "@/lib/money";
import { ItemDialog } from "./item-dialog";

export function MenuBrowser({
  menu,
  orderingEnabled,
}: {
  menu: CategoryView[];
  orderingEnabled: boolean;
}) {
  const [activeItem, setActiveItem] = useState<MenuItemView | null>(null);

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6">
      {/* Category jump nav */}
      <nav className="sticky top-16 z-30 -mx-4 flex gap-1 overflow-x-auto border-b border-border bg-background/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6">
        {menu.map((cat) => (
          <a
            key={cat.id}
            href={`#category-${cat.id}`}
            className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface hover:text-foreground"
          >
            {cat.name}
          </a>
        ))}
      </nav>

      {menu.map((cat) => (
        <section
          key={cat.id}
          id={`category-${cat.id}`}
          className="scroll-mt-32 py-10"
        >
          <h2 className="text-xl font-semibold tracking-tight">{cat.name}</h2>
          {cat.description ? (
            <p className="mt-1 text-sm text-muted">{cat.description}</p>
          ) : null}
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {cat.items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveItem(item)}
                className="group flex items-start justify-between gap-4 rounded-lg border border-border p-4 text-left transition-colors hover:border-foreground/30"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{item.name}</span>
                    {item.isFeatured ? (
                      <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted">
                        Popular
                      </span>
                    ) : null}
                  </div>
                  {item.description ? (
                    <p className="mt-1 line-clamp-2 text-sm text-muted">
                      {item.description}
                    </p>
                  ) : null}
                  <p className="mt-2 text-sm font-medium tabular-nums">
                    {item.modifierGroups.some((g) => g.minSelect > 0)
                      ? `from ${formatCents(item.basePriceCents + minRequiredDelta(item))}`
                      : formatCents(item.basePriceCents)}
                  </p>
                </div>
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-muted transition-colors group-hover:border-foreground group-hover:text-foreground">
                  +
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}

      {activeItem ? (
        <ItemDialog
          item={activeItem}
          orderingEnabled={orderingEnabled}
          onClose={() => setActiveItem(null)}
        />
      ) : null}
    </div>
  );
}

/** Cheapest required selections (e.g. smallest size) for "from $X" pricing. */
function minRequiredDelta(item: MenuItemView): number {
  let delta = 0;
  for (const group of item.modifierGroups) {
    if (group.minSelect > 0 && group.modifiers.length > 0) {
      const cheapest = [...group.modifiers].sort(
        (a, b) => a.priceDeltaCents - b.priceDeltaCents,
      )[0];
      delta += cheapest.priceDeltaCents * group.minSelect;
    }
  }
  return delta;
}
