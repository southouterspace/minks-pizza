"use client";

import { useMemo, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { toast } from "sonner";
import type { MenuItemView, ModifierGroupView } from "@/lib/menu";
import { formatCents } from "@/lib/money";
import { useCart, type CartModifier } from "@/components/cart-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Row shell shared by the radio and checkbox variants of an option. */
const optionRowClass = (checked: boolean) =>
  cn(
    "flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-sm font-normal transition-colors",
    checked
      ? "border-foreground bg-muted"
      : "border-border hover:border-foreground/30",
  );

function groupHint(group: ModifierGroupView): string {
  if (group.minSelect > 0) {
    return group.maxSelect === 1
      ? "Required"
      : `Choose at least ${group.minSelect}`;
  }
  return group.maxSelect ? `Up to ${group.maxSelect}` : "Optional";
}

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
    toast.success(`${quantity} × ${item.name} added to cart`);
    setTimeout(onClose, 400);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg!">
        <DialogHeader className="pr-8 text-left">
          <DialogTitle>{item.name}</DialogTitle>
          {item.description ? (
            <DialogDescription>{item.description}</DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="-mx-4 overflow-y-auto px-4">
          {item.modifierGroups.map((group) => (
            <fieldset key={group.id} className="mb-6 last:mb-0">
              <legend className="flex items-baseline gap-2 text-sm font-semibold">
                {group.name}
                <span className="text-xs font-normal text-muted-foreground">
                  {groupHint(group)}
                </span>
              </legend>

              {group.maxSelect === 1 ? (
                <RadioGroup
                  className="mt-3"
                  value={
                    group.modifiers.find((m) => selected.has(m.id))?.id ?? null
                  }
                  onValueChange={(value) => {
                    if (typeof value === "number") toggle(group.id, value);
                  }}
                >
                  {group.modifiers.map((mod) => {
                    const checked = selected.has(mod.id);
                    return (
                      <label key={mod.id} className={optionRowClass(checked)}>
                        <span className="flex items-center gap-3">
                          <RadioGroupItem value={mod.id} />
                          {mod.name}
                        </span>
                        {mod.priceDeltaCents !== 0 ? (
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            +{formatCents(mod.priceDeltaCents)}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </RadioGroup>
              ) : (
                <div className="mt-3 grid gap-2">
                  {group.modifiers.map((mod) => {
                    const checked = selected.has(mod.id);
                    return (
                      <label key={mod.id} className={optionRowClass(checked)}>
                        <span className="flex items-center gap-3">
                          <Checkbox
                            checked={checked}
                            onCheckedChange={() => toggle(group.id, mod.id)}
                          />
                          {mod.name}
                        </span>
                        {mod.priceDeltaCents !== 0 ? (
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            +{formatCents(mod.priceDeltaCents)}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              )}
            </fieldset>
          ))}

          <div className="mt-6">
            <Label htmlFor="item-notes" className="text-sm font-semibold">
              Special instructions{" "}
              <span className="text-xs font-normal text-muted-foreground">
                Optional
              </span>
            </Label>
            <Textarea
              id="item-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="e.g. extra crispy, cut in squares"
              className="mt-2 resize-none"
            />
          </div>
        </div>

        <DialogFooter className="flex-row items-center gap-3 sm:justify-start">
          <div className="flex shrink-0 items-center rounded-lg border border-border bg-background">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              aria-label="Decrease quantity"
            >
              <Minus />
            </Button>
            <span className="w-8 text-center text-sm font-medium tabular-nums">
              {quantity}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setQuantity((q) => Math.min(50, q + 1))}
              aria-label="Increase quantity"
            >
              <Plus />
            </Button>
          </div>
          <Button
            disabled={violations.length > 0 || !orderingEnabled || added}
            onClick={add}
            className="h-10! flex-1"
          >
            {added
              ? "Added ✓"
              : !orderingEnabled
                ? "Ordering paused"
                : violations.length > 0
                  ? `Choose ${violations[0].name}`
                  : `Add ${quantity} to cart · ${formatCents(unitPrice * quantity)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
