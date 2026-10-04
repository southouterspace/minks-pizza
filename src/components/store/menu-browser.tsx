"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import type { CategoryView, MenuItemView } from "@/lib/menu";
import { formatCents } from "@/lib/money";
import { pricesAt } from "@/lib/pricing";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
            className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
            <p className="mt-1 text-sm text-muted-foreground">
              {cat.description}
            </p>
          ) : null}
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {cat.items.map((item) => (
              <Card
                key={item.id}
                role="button"
                tabIndex={0}
                aria-haspopup="dialog"
                onClick={() => setActiveItem(item)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveItem(item);
                  }
                }}
                className="group cursor-pointer text-left transition-shadow outline-none hover:ring-foreground/25 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CardContent className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{item.name}</span>
                      {item.isFeatured ? (
                        <Badge variant="secondary">Popular</Badge>
                      ) : null}
                      {item.isAlcoholic ? (
                        <Badge variant="outline">21+</Badge>
                      ) : null}
                    </div>
                    {item.description ? (
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {item.description}
                      </p>
                    ) : null}
                    <p className="mt-2 text-sm font-medium tabular-nums">
                      {item.modifierGroups.some((g) => g.minSelect > 0)
                        ? `from ${formatCents(item.basePriceCents + minRequiredDelta(item))}`
                        : formatCents(item.basePriceCents)}
                    </p>
                  </div>
                  <span
                    aria-hidden
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors group-hover:border-foreground group-hover:text-foreground"
                  >
                    <Plus className="size-4" />
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}

      {activeItem ? (
        <ItemDialog
          key={activeItem.id}
          item={activeItem}
          orderingEnabled={orderingEnabled}
          onClose={() => setActiveItem(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Cheapest required selections (e.g. smallest size) for "from $X" pricing,
 * trying each size since the other options can cost more on some sizes.
 */
function minRequiredDelta(item: MenuItemView): number {
  const sizeGroup = item.modifierGroups.find((g) => g.role === "size");
  const sizeIds = sizeGroup?.minSelect && sizeGroup.modifiers.length ? sizeGroup.modifiers.map((m) => m.id) : [null];
  return Math.min(
    ...sizeIds.map((sizeId) =>
      item.modifierGroups.reduce((delta, group) => {
        if (group.minSelect === 0 || group.modifiers.length === 0) return delta;
        const options = group === sizeGroup ? group.modifiers.filter((m) => m.id === sizeId) : group.modifiers;
        const cheapest = Math.min(...options.map((m) => pricesAt(m, sizeId).priceDeltaCents));
        return delta + cheapest * group.minSelect;
      }, 0),
    ),
  );
}
