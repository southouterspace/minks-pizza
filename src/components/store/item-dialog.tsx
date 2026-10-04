"use client";

import { useEffect, useMemo, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { toast } from "sonner";
import type { MenuItemView, ModifierGroupView, ModifierView } from "@/lib/menu";
import { formatCents } from "@/lib/money";
import { addableQuantity } from "@/app/(store)/actions";
import { toCartLineInput, useCart, type CartModifier } from "@/components/cart-context";
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
import {
  AMOUNT_LABEL,
  isPlaceable,
  priceLine,
  PricingError,
  type Amount,
  type MenuItem,
  type Placement,
  type Selection,
} from "@/lib/pricing";
import { PizzaGlyph } from "@/components/pizza-glyph";

type ToppingChoice = { placement: Placement; amount: Amount };
const DEFAULT_CHOICE: ToppingChoice = { placement: "whole", amount: "regular" };
const AMOUNT_OPTIONS: Amount[] = ["light", "regular", "extra"];

/** The dialog prices with the same function checkout does, over the live menu. */
function pricingItem(item: MenuItemView, relaxed: boolean): MenuItem {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    basePriceCents: item.basePriceCents,
    isAvailable: true,
    station: "kitchen",
    groups: relaxed ? item.modifierGroups.map((g) => ({ ...g, minSelect: 0, maxSelect: null })) : item.modifierGroups,
  };
}

/** Row shell shared by the radio and checkbox variants of an option. */
const optionRowClass = (checked: boolean) =>
  cn(
    "flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-sm font-normal transition-colors",
    checked
      ? "border-foreground bg-muted"
      : "border-border hover:border-foreground/30",
  );

/** What one choice adds on its own, for the row's price hint. */
function selectionPrice(item: MenuItemView, mod: ModifierView, choice: ToppingChoice): number {
  const priced = priceLine(pricingItem(item, true), [{ modifierId: mod.id, ...choice }], item.policy);
  return priced.unitPriceCents - item.basePriceCents;
}

const PLACEMENT_OPTIONS: { value: Placement; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "whole", label: "Whole" },
  { value: "right", label: "Right" },
];

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; icon?: React.ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg border border-border bg-background p-0.5"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex h-10 items-center justify-center gap-1.5 rounded-md px-2 text-sm transition-colors sm:h-9",
              active
                ? "bg-foreground font-medium text-background"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ToppingOption({
  mod,
  checked,
  choice,
  priceCents,
  onToggle,
  onChoice,
}: {
  mod: ModifierView;
  checked: boolean;
  choice: ToppingChoice;
  priceCents: number;
  onToggle: () => void;
  onChoice: (patch: Partial<ToppingChoice>) => void;
}) {
  return (
    <div data-topping={mod.name} className={cn(optionRowClass(checked), "block p-0")}>
      <label className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5">
        <span className="flex items-center gap-3">
          <Checkbox checked={checked} onCheckedChange={onToggle} />
          {mod.name}
          {checked && choice.placement !== "whole" ? (
            <PizzaGlyph placement={choice.placement} className="text-muted-foreground" />
          ) : null}
        </span>
        {priceCents !== 0 ? (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            +{formatCents(priceCents)}
          </span>
        ) : null}
      </label>
      {checked ? (
        <div className="grid gap-2 border-t border-border px-3.5 py-3 sm:grid-cols-2">
          <Segmented
            label={`${mod.name} placement`}
            value={choice.placement}
            options={PLACEMENT_OPTIONS.map((o) => ({
              ...o,
              icon: <PizzaGlyph placement={o.value} />,
            }))}
            onChange={(placement) => onChoice({ placement })}
          />
          <Segmented
            label={`${mod.name} amount`}
            value={choice.amount}
            options={AMOUNT_OPTIONS.map((a) => ({ value: a, label: AMOUNT_LABEL[a] }))}
            onChange={(amount) => onChoice({ amount })}
          />
        </div>
      ) : null}
    </div>
  );
}

function groupHint(group: ModifierGroupView): string {
  if (group.minSelect > 0) {
    return group.maxSelect === 1
      ? "Required"
      : `Choose at least ${group.minSelect}`;
  }
  return group.maxSelect ? `Up to ${group.maxSelect}` : "Optional";
}

export function ItemDialog({
  item,
  orderingEnabled,
  onClose,
}: {
  item: MenuItemView;
  orderingEnabled: boolean;
  onClose: () => void;
}) {
  const { lines, addLine } = useCart();
  const [selected, setSelected] = useState<Map<number, ToppingChoice>>(() => {
    const initial = new Map<number, ToppingChoice>();
    for (const group of item.modifierGroups) {
      const defaults = group.modifiers.filter((m) => m.isDefault);
      const picks =
        defaults.length > 0
          ? defaults
          : group.minSelect > 0
            ? group.modifiers.slice(0, group.minSelect)
            : [];
      for (const p of picks.slice(0, group.maxSelect ?? picks.length)) {
        initial.set(p.id, DEFAULT_CHOICE);
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
      const next = new Map(prev);
      const groupModIds = group.modifiers.map((m) => m.id);
      if (group.maxSelect === 1) {
        // radio behavior
        for (const id of groupModIds) next.delete(id);
        next.set(modId, DEFAULT_CHOICE);
      } else if (next.has(modId)) {
        next.delete(modId);
      } else {
        const count = groupModIds.filter((id) => next.has(id)).length;
        if (group.maxSelect !== null && count >= group.maxSelect) return prev;
        next.set(modId, DEFAULT_CHOICE);
      }
      return next;
    });
  };

  const setChoice = (modId: number, patch: Partial<ToppingChoice>) =>
    setSelected((prev) => {
      const current = prev.get(modId);
      return current ? new Map(prev).set(modId, { ...current, ...patch }) : prev;
    });

  const selections: Selection[] = useMemo(
    () =>
      item.modifierGroups.flatMap((g) =>
        g.modifiers.flatMap((m) => {
          const choice = selected.get(m.id);
          if (!choice) return [];
          return [{ modifierId: m.id, ...(isPlaceable(g.role) ? choice : DEFAULT_CHOICE) }];
        }),
      ),
    [item, selected],
  );

  const priced = useMemo(() => {
    try {
      return priceLine(pricingItem(item, true), selections, item.policy);
    } catch (err) {
      if (err instanceof PricingError) return { unitPriceCents: item.basePriceCents, modifiers: [] as CartModifier[] };
      throw err;
    }
  }, [item, selections]);
  const chosen = priced.modifiers;
  const unitPrice = priced.unitPriceCents;

  // undefined until the server answers; null means nothing tracked limits this item.
  const [limit, setLimit] = useState<{ key: string; max: number | null }>();
  const limitKey = JSON.stringify({ cart: lines.map(toCartLineInput), line: { itemId: item.id, quantity: 1, selections } });
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(async () => {
      const max = await addableQuantity(JSON.parse(limitKey)).catch(() => null);
      if (!stale) setLimit({ key: limitKey, max });
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [limitKey]);
  const max = limit?.max ?? null;
  const checking = limit?.key !== limitKey;
  const count = max === null ? quantity : Math.min(quantity, max);

  const violations = item.modifierGroups.filter((g) => {
    const count = g.modifiers.filter((m) => selected.has(m.id)).length;
    return count < g.minSelect;
  });

  const add = () => {
    addLine({
      itemId: item.id,
      itemName: item.name,
      unitPriceCents: unitPrice,
      quantity: count,
      selections,
      modifiers: chosen,
      notes: notes.trim() || undefined,
    });
    setAdded(true);
    toast.success(`${count} × ${item.name} added to cart`);
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

              {isPlaceable(group.role) ? (
                <div className="mt-3 grid gap-2">
                  {group.modifiers.map((mod) => {
                    const choice = selected.get(mod.id);
                    return (
                      <ToppingOption
                        key={mod.id}
                        mod={mod}
                        checked={choice !== undefined}
                        choice={choice ?? DEFAULT_CHOICE}
                        priceCents={selectionPrice(item, mod, choice ?? DEFAULT_CHOICE)}
                        onToggle={() => toggle(group.id, mod.id)}
                        onChoice={(patch) => setChoice(mod.id, patch)}
                      />
                    );
                  })}
                </div>
              ) : group.maxSelect === 1 ? (
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

        <DialogFooter className="flex-row flex-wrap items-center gap-3 sm:justify-start">
          {max !== null && max > 0 && count >= max ? (
            <p role="status" className="w-full text-xs text-muted-foreground">
              Only {max} more can be made right now.
            </p>
          ) : null}
          <div className="flex shrink-0 items-center rounded-lg border border-border bg-background">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setQuantity(Math.max(1, count - 1))}
              aria-label="Decrease quantity"
            >
              <Minus />
            </Button>
            <span className="w-8 text-center text-sm font-medium tabular-nums">
              {count}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setQuantity(Math.min(50, count + 1))}
              disabled={max !== null && count >= max}
              aria-label="Increase quantity"
            >
              <Plus />
            </Button>
          </div>
          <Button
            disabled={violations.length > 0 || !orderingEnabled || added || checking || max === 0}
            onClick={add}
            className="h-10! flex-1"
          >
            {added
              ? "Added ✓"
              : !orderingEnabled
                ? "Ordering paused"
                : max === 0
                  ? lines.some((l) => l.itemId === item.id)
                    ? "No more available"
                    : "Sold out"
                  : violations.length > 0
                    ? `Choose ${violations[0].name}`
                    : `Add ${count} to cart · ${formatCents(unitPrice * count)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
