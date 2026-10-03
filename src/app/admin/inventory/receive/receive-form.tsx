"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, TriangleAlert, X } from "lucide-react";
import { receiveDelivery } from "@/app/admin/inventory/actions";
import type { EntryIngredient } from "@/app/admin/inventory/entry";
import type { PriceChange } from "@/lib/inventory";
import { formatCents } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

type Line = { key: number; ingredientId: number; qty: string; unit: string; cost: string };
type Saved = { vendor: string; lines: number; priceChanges: PriceChange[] };

function blankLine(key: number, ing: EntryIngredient | undefined): Line {
  return { key, ingredientId: ing?.id ?? 0, qty: "", unit: ing?.defaultUnit ?? "", cost: "" };
}

const lineCents = (l: Line) => Math.round(Number(l.qty) * Number(l.cost) * 100) || 0;

export function ReceiveForm({ ingredients }: { ingredients: EntryIngredient[] }) {
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const [vendor, setVendor] = useState("");
  const lastKey = useRef(0);
  const freshLine = () => blankLine(++lastKey.current, ingredients[0]);
  const [lines, setLines] = useState<Line[]>(() => [blankLine(0, ingredients[0])]);
  const [saved, setSaved] = useState<Saved | null>(null);

  const patch = (key: number, p: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const [pending, startTransition] = useTransition();

  async function submit() {
    const fd = new FormData();
    fd.set(
      "payload",
      JSON.stringify({
        vendor,
        lines: lines.map((l) => ({
          ingredientId: l.ingredientId,
          qty: Number(l.qty),
          unit: l.unit,
          cost: Number(l.cost),
        })),
      }),
    );
    const result = await receiveDelivery(fd);
    if (!result.ok) return void toast.error(result.error);
    setSaved({ vendor, lines: result.lines, priceChanges: result.priceChanges });
    setVendor("");
    setLines([freshLine()]);
  }

  return (
    <>
      {saved ? (
        <div role="status" data-testid="delivery-saved" className="mt-6 space-y-2">
          <p className="text-sm font-medium text-success">
            Received {saved.lines} {saved.lines === 1 ? "line" : "lines"}
            {saved.vendor ? ` from ${saved.vendor}` : ""}.
          </p>
          {saved.priceChanges.map((c) => (
            <p
              key={c.name}
              data-testid="price-warning"
              className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
            >
              <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
              {c.name} {c.pct > 0 ? "+" : "−"}
              {Math.abs(c.pct)}% vs last delivery
            </p>
          ))}
        </div>
      ) : null}

      <form
      // Not a form action: React resets a form after its action resolves, which knocks controlled selects back to their first option.
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(submit);
      }}
      className="mt-6 space-y-4"
    >
        <Field className="sm:max-w-xs">
          <FieldLabel htmlFor="vendor">Vendor</FieldLabel>
          <Input
            id="vendor"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            maxLength={120}
            placeholder="Sysco, Restaurant Depot…"
          />
        </Field>

        <Card className="gap-0! py-0!">
          {lines.map((l, i) => {
            const ing = byId.get(l.ingredientId);
            return (
              <div
                key={l.key}
                data-testid="delivery-line"
                className={`grid grid-cols-2 gap-3 p-4 sm:grid-cols-[1fr_5rem_6rem_7rem_auto] sm:items-end ${i > 0 ? "border-t border-border" : ""}`}
              >
                <Field className="col-span-2 sm:col-span-1">
                  <FieldLabel htmlFor={`line-ing-${l.key}`}>Ingredient</FieldLabel>
                  <NativeSelect
                    id={`line-ing-${l.key}`}
                    value={l.ingredientId}
                    onChange={(e) => {
                      const next = byId.get(Number(e.target.value));
                      patch(l.key, { ingredientId: Number(e.target.value), unit: next?.defaultUnit ?? "" });
                    }}
                    className="w-full"
                  >
                    {ingredients.map((x) => (
                      <NativeSelectOption key={x.id} value={x.id}>
                        {x.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`line-qty-${l.key}`}>Qty</FieldLabel>
                  <Input
                    id={`line-qty-${l.key}`}
                    inputMode="decimal"
                    autoComplete="off"
                    required
                    value={l.qty}
                    onChange={(e) => patch(l.key, { qty: e.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`line-unit-${l.key}`}>Unit</FieldLabel>
                  <NativeSelect
                    id={`line-unit-${l.key}`}
                    value={l.unit}
                    onChange={(e) => patch(l.key, { unit: e.target.value })}
                    className="w-full"
                  >
                    {ing?.units.map((u) => (
                      <NativeSelectOption key={u} value={u}>
                        {u}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`line-cost-${l.key}`}>$ per {l.unit || "unit"}</FieldLabel>
                  <Input
                    id={`line-cost-${l.key}`}
                    inputMode="decimal"
                    autoComplete="off"
                    required
                    value={l.cost}
                    onChange={(e) => patch(l.key, { cost: e.target.value })}
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove line"
                  disabled={lines.length === 1}
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  className="self-end justify-self-end text-muted-foreground"
                >
                  <X />
                </Button>
              </div>
            );
          })}
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const line = freshLine();
              setLines((ls) => [...ls, line]);
            }}
          >
            <Plus aria-hidden="true" />
            Add line
          </Button>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground tabular-nums">
              Total {formatCents(lines.reduce((s, l) => s + lineCents(l), 0))}
            </span>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save delivery"}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
