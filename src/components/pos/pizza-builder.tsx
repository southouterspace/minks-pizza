"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, X } from "lucide-react";
import { cyclePlacement, groupsInEntryOrder, pickOption, selectionOf, tapTopping } from "@/lib/pos-client/builder";
import { draftLine, lineSummary, type DraftLine } from "@/lib/pos-client/draft";
import { formatCents } from "@/lib/money";
import {
  chosenSize,
  isPlaceable,
  priceLine,
  pricesAt,
  PricingError,
  type MenuGroup,
  type MenuItem,
  type MenuModifier,
  type Placement,
  type PricingPolicy,
  type Selection,
} from "@/lib/pricing";
import { cn } from "@/lib/utils";
import { Segmented, Tap } from "./touch";

const PLACEMENT_OPTIONS: { value: Placement; label: string }[] = [
  { value: "whole", label: "Whole" },
  { value: "left", label: "Left ½" },
  { value: "right", label: "Right ½" },
];

const AMOUNT_TAG = { regular: null, extra: "EXTRA", light: "LIGHT", none: "NO" } as const;
const HALF_TAG = { whole: null, left: "L", right: "R" } as const;
const LONG_PRESS_MS = 450;

/**
 * One screen for one line, beside the order panel: options in entry order,
 * then a toppings grid. Tap a topping to cycle its amount; Whole/Left/Right
 * picks the half the next tap lands on; long-press cycles one topping's half.
 */
export function PizzaBuilder({
  item,
  policy,
  initial,
  onDone,
  onCancel,
}: {
  item: MenuItem;
  policy: PricingPolicy;
  initial: { selections: Selection[]; quantity: number; notes: string | null; lineId?: string };
  onDone: (line: DraftLine) => void;
  onCancel: () => void;
}) {
  const [sel, setSel] = useState(initial.selections);
  const [quantity, setQuantity] = useState(initial.quantity);
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [active, setActive] = useState<Placement>("whole");
  const groups = useMemo(() => groupsInEntryOrder(item), [item]);
  const sizeId = chosenSize(item.groups, sel);
  const editing = initial.lineId !== undefined;

  const priced = useMemo(() => {
    try {
      return { ok: true as const, ...priceLine(item, sel, policy) };
    } catch (err) {
      if (err instanceof PricingError) return { ok: false as const, message: err.message };
      throw err;
    }
  }, [item, sel, policy]);

  const done = () => {
    if (!priced.ok) return;
    onDone(draftLine(item, sel, quantity, notes.trim() || null, policy, initial.lineId));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && !(e.target as HTMLElement).closest("textarea")) done();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="builder">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onCancel} className="rounded-xl p-3 hover:bg-muted" aria-label="Close builder">
          <X className="size-5" />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-xl font-semibold">{item.name}</h2>
        <div className="flex items-center gap-1 rounded-xl bg-muted p-1">
          <button type="button" className="flex size-11 items-center justify-center rounded-lg hover:bg-background" onClick={() => setQuantity((q) => Math.max(1, q - 1))} aria-label="One fewer">
            <Minus className="size-5" />
          </button>
          <span className="w-8 text-center text-xl font-semibold tabular-nums" data-testid="builder-qty">
            {quantity}
          </span>
          <button type="button" className="flex size-11 items-center justify-center rounded-lg hover:bg-background" onClick={() => setQuantity((q) => Math.min(50, q + 1))} aria-label="One more">
            <Plus className="size-5" />
          </button>
        </div>
        <Tap onClick={done} disabled={!priced.ok} className="min-w-40" data-testid="builder-add">
          {editing ? "Update" : "Add"} · {priced.ok ? formatCents(priced.unitPriceCents * quantity) : "—"}
        </Tap>
      </div>

      <p className={cn("-mt-1 rounded-xl bg-muted px-3 py-2 text-base", !priced.ok && "text-destructive")} data-testid="builder-summary">
        {quantity} × {priced.ok ? lineSummary(priced.modifiers) || item.name : priced.message}
      </p>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1 pb-2">
        {groups.map((g) =>
          isPlaceable(g.role) ? (
            <ToppingGroup
              key={g.id}
              group={g}
              sel={sel}
              sizeId={sizeId}
              active={active}
              onActive={setActive}
              onTap={(m) => setSel((s) => tapTopping(s, m, active))}
              onLongPress={(m) => setSel((s) => cyclePlacement(s, m))}
            />
          ) : (
            <OptionGroup key={g.id} group={g} sel={sel} sizeId={sizeId} onPick={(m) => setSel((s) => pickOption(s, g, m))} />
          ),
        )}
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-muted-foreground">Line note</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="well done, cut in squares…"
            className="h-12 rounded-xl border bg-background px-3 text-base outline-none focus:ring-3 focus:ring-ring/40"
          />
        </label>
      </div>
    </div>
  );
}

function OptionGroup({
  group,
  sel,
  sizeId,
  onPick,
}: {
  group: MenuGroup;
  sel: Selection[];
  sizeId: number | null;
  onPick: (m: MenuModifier) => void;
}) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
        {group.name}
        {group.minSelect > 0 && <span className="ml-1 normal-case">(required)</span>}
      </h3>
      <div className="grid grid-cols-4 gap-2">
        {group.modifiers.map((m) => {
          const on = !!selectionOf(sel, m.id);
          const priceCents = pricesAt(m, sizeId).priceDeltaCents;
          return (
            <button
              key={m.id}
              type="button"
              disabled={!m.isAvailable}
              onClick={() => onPick(m)}
              aria-pressed={on}
              className={cn(
                "flex h-14 flex-col items-center justify-center rounded-xl border px-2 text-center text-base leading-tight font-medium transition",
                on ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-foreground/30",
                !m.isAvailable && "opacity-40",
              )}
            >
              <span className="line-clamp-1">{m.name}</span>
              {priceCents > 0 && <span className="text-xs opacity-70">+{formatCents(priceCents)}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ToppingGroup({
  group,
  sel,
  sizeId,
  active,
  onActive,
  onTap,
  onLongPress,
}: {
  group: MenuGroup;
  sel: Selection[];
  sizeId: number | null;
  active: Placement;
  onActive: (p: Placement) => void;
  onTap: (m: MenuModifier) => void;
  onLongPress: (m: MenuModifier) => void;
}) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">{group.name}</h3>
        <Segmented value={active} options={PLACEMENT_OPTIONS} onChange={onActive} className="w-80" size="sm" />
      </div>
      <div className="grid grid-cols-4 gap-2">
        {group.modifiers.map((m) => {
          const s = selectionOf(sel, m.id);
          const on = s && s.amount !== "none";
          const removed = s?.amount === "none";
          const amountTag = s ? AMOUNT_TAG[s.amount] : null;
          const halfTag = s && !removed ? HALF_TAG[s.placement] : null;
          const priceCents = pricesAt(m, sizeId).priceDeltaCents;
          return (
            <button
              key={m.id}
              type="button"
              disabled={!m.isAvailable}
              data-topping={m.name}
              data-state={s ? `${s.placement}:${s.amount}` : "off"}
              onPointerDown={() => {
                press.current = {
                  fired: false,
                  timer: setTimeout(() => {
                    if (press.current) press.current.fired = true;
                    onLongPress(m);
                  }, LONG_PRESS_MS),
                };
              }}
              onPointerUp={() => press.current && clearTimeout(press.current.timer)}
              onPointerLeave={() => press.current && clearTimeout(press.current.timer)}
              onClick={() => {
                if (press.current?.fired) {
                  press.current = null;
                  return;
                }
                onTap(m);
              }}
              onContextMenu={(e) => e.preventDefault()}
              className={cn(
                "relative flex h-16 flex-col items-center justify-center rounded-xl border px-2 text-center text-base leading-tight font-medium transition select-none",
                on && "border-primary bg-primary text-primary-foreground",
                removed && "border-destructive bg-destructive/10 text-destructive line-through",
                !s && "bg-card hover:border-foreground/30",
                !m.isAvailable && "opacity-40",
              )}
            >
              <span className="line-clamp-1">{m.name}</span>
              <span className="text-xs opacity-75">
                {amountTag ?? (m.isDefault ? "on pizza" : priceCents > 0 ? `+${formatCents(priceCents)}` : " ")}
              </span>
              {halfTag && (
                <span className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-full bg-background text-xs font-bold text-foreground">
                  {halfTag}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Tap: add → extra → light → off. Long-press: move to a half.</p>
    </section>
  );
}
