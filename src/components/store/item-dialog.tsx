"use client";

import { useEffect, useMemo, useState } from "react";
import type { MenuItemView } from "@/lib/menu";
import { formatCents } from "@/lib/money";
import { useCart, type CartModifier } from "@/components/cart-context";

/**
 * Item customization dialog: radio for single-select groups (maxSelect = 1),
 * checkboxes otherwise. Defaults are pre-selected. Enforces min/max locally;
 * the server re-validates at checkout.
 */
export function ItemDialog({
  item,
  orderingEnabled,
  onClose,
}: {
  item: MenuItemView;
  orderingEnabled: boolean;
  onClose: () => void;
}) {
  const { addLine } = useCart();
  const [selected, setSelected] = useState<Set<number>>(() => {
    const initial = new Set<number>();
    for (const group of item.modifierGroups) {
      const defaults = group.modifiers.filter((m) => m.isDefault);
      const picks =
        defaults.length > 0
          ? defaults
          : group.minSelect > 0
            ? group.modifiers.slice(0, group.minSelect)
            : [];
      for (const p of picks.slice(0, group.maxSelect ?? picks.length)) {
        initial.add(p.id);
      }
    }
    return initial;
  });
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [added, setAdded] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const toggle = (groupId: number, modId: number) => {
    const group = item.modifierGroups.find((g) => g.id === groupId);
    if (!group) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const groupModIds = group.modifiers.map((m) => m.id);
      if (group.maxSelect === 1) {
        // radio behavior
        for (const id of groupModIds) next.delete(id);
        next.add(modId);
      } else if (next.has(modId)) {
        next.delete(modId);
      } else {
        const count = groupModIds.filter((id) => next.has(id)).length;
        if (group.maxSelect !== null && count >= group.maxSelect) return prev;
        next.add(modId);
      }
      return next;
    });
  };

  const chosen: CartModifier[] = useMemo(
    () =>
      item.modifierGroups.flatMap((g) =>
        g.modifiers
          .filter((m) => selected.has(m.id))
          .map((m) => ({
            id: m.id,
            groupName: g.name,
            modifierName: m.name,
            priceDeltaCents: m.priceDeltaCents,
          })),
      ),
    [item, selected],
  );

  const unitPrice =
    item.basePriceCents + chosen.reduce((n, m) => n + m.priceDeltaCents, 0);

  const violations = item.modifierGroups.filter((g) => {
    const count = g.modifiers.filter((m) => selected.has(m.id)).length;
    return count < g.minSelect;
  });

  const add = () => {
    addLine({
      itemId: item.id,
      itemName: item.name,
      unitPriceCents: unitPrice,
      quantity,
      modifiers: chosen,
      notes: notes.trim() || undefined,
    });
    setAdded(true);
    setTimeout(onClose, 400);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Customize ${item.name}`}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-t-xl border border-border bg-background sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              {item.name}
            </h2>
            {item.description ? (
              <p className="mt-1 text-sm text-muted">{item.description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {item.modifierGroups.map((group) => (
            <fieldset key={group.id} className="mb-6 last:mb-0">
              <legend className="flex items-baseline gap-2 text-sm font-semibold">
                {group.name}
                <span className="text-xs font-normal text-faint">
                  {group.minSelect > 0
                    ? group.maxSelect === 1
                      ? "Required"
                      : `Choose at least ${group.minSelect}`
                    : group.maxSelect
                      ? `Up to ${group.maxSelect}`
                      : "Optional"}
                </span>
              </legend>
              <div className="mt-3 space-y-1.5">
                {group.modifiers.map((mod) => {
                  const checked = selected.has(mod.id);
                  return (
                    <label
                      key={mod.id}
                      className={`flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3.5 py-2.5 text-sm transition-colors ${
                        checked
                          ? "border-foreground bg-surface"
                          : "border-border hover:border-foreground/30"
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <input
                          type={group.maxSelect === 1 ? "radio" : "checkbox"}
                          name={`group-${group.id}`}
                          checked={checked}
                          onChange={() => toggle(group.id, mod.id)}
                          className="h-4 w-4 accent-black"
                        />
                        {mod.name}
                      </span>
                      {mod.priceDeltaCents !== 0 ? (
                        <span className="tabular-nums text-muted">
                          +{formatCents(mod.priceDeltaCents)}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}

          <div className="mt-2">
            <label
              htmlFor="item-notes"
              className="text-sm font-semibold"
            >
              Special instructions{" "}
              <span className="text-xs font-normal text-faint">Optional</span>
            </label>
            <textarea
              id="item-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="e.g. extra crispy, cut in squares"
              className="mt-2 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint focus:border-foreground"
            />
          </div>
        </div>

        <div className="border-t border-border p-5">
          <div className="flex items-center gap-3">
            <div className="flex items-center rounded-md border border-border">
              <button
                type="button"
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                aria-label="Decrease quantity"
                className="h-10 w-10 text-lg text-muted transition-colors hover:text-foreground"
              >
                −
              </button>
              <span className="w-8 text-center text-sm font-medium tabular-nums">
                {quantity}
              </span>
              <button
                type="button"
                onClick={() => setQuantity((q) => Math.min(50, q + 1))}
                aria-label="Increase quantity"
                className="h-10 w-10 text-lg text-muted transition-colors hover:text-foreground"
              >
                +
              </button>
            </div>
            <button
              type="button"
              disabled={violations.length > 0 || !orderingEnabled || added}
              onClick={add}
              className="flex h-10 flex-1 items-center justify-center gap-2 rounded-md bg-accent text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {added
                ? "Added ✓"
                : !orderingEnabled
                  ? "Ordering paused"
                  : violations.length > 0
                    ? `Choose ${violations[0].name}`
                    : `Add ${quantity} to cart · ${formatCents(unitPrice * quantity)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
