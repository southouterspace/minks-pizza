"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check } from "lucide-react";
import type { CountKind } from "@/lib/inventory-domain";
import { submitCount } from "@/app/admin/inventory/actions";
import { byArea, type EntryIngredient } from "@/app/admin/inventory/entry";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

type DraftLine = { qty: string; unit: string };
type Draft = Partial<Record<number, DraftLine>>;

const storageKey = (kind: CountKind) => `minks:count-draft:${kind}`;

/** Browser storage can be missing or throw (private mode, blocked site data); the sheet still works without it. */
const store = {
  read(kind: CountKind): Draft {
    try {
      return JSON.parse(localStorage.getItem(storageKey(kind)) ?? "{}") as Draft;
    } catch {
      return {};
    }
  },
  write(kind: CountKind, draft: Draft): boolean {
    try {
      localStorage.setItem(storageKey(kind), JSON.stringify(draft));
      return true;
    } catch {
      return false;
    }
  },
  clear(kind: CountKind): void {
    try {
      localStorage.removeItem(storageKey(kind));
    } catch {}
  },
};

const isCounted = (line: DraftLine | undefined): line is DraftLine => line !== undefined && line.qty.trim() !== "";

export function CountSheet({
  kind,
  ingredients,
}: {
  kind: CountKind;
  ingredients: EntryIngredient[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const restored = store.read(kind);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the draft lives in this device's storage, which the server render can't see
    setDraft(restored);
    setSaved(Object.values(restored).some(isCounted));
  }, [kind]);

  function update(id: number, patch: Partial<DraftLine>, fallbackUnit: string) {
    const next = { ...draft, [id]: { qty: "", unit: fallbackUnit, ...draft[id], ...patch } };
    setDraft(next);
    setSaved(store.write(kind, next));
  }

  const known = new Map(ingredients.map((i) => [i.id, i]));
  const counted = ingredients.filter((i) => isCounted(draft[i.id])).length;

  const [pending, startTransition] = useTransition();

  async function submit() {
    const lines = Object.entries(draft).flatMap(([id, line]) =>
      isCounted(line) && known.has(Number(id))
        ? [{ ingredientId: Number(id), qty: Number(line.qty), unit: line.unit }]
        : [],
    );
    const fd = new FormData();
    fd.set("payload", JSON.stringify({ kind, lines }));
    const result = await submitCount(fd);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    store.clear(kind);
    router.push("/admin/inventory?notice=counted");
  }

  return (
    <form
      // Not a form action: React resets a form after its action resolves, which knocks controlled selects back to their first option.
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(submit);
      }}
      className="mt-6 space-y-6 pb-24"
    >
      {byArea(ingredients).map(({ area, rows }) => (
        <section key={area}>
          <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {area}
          </h2>
          <Card className="gap-0! py-0!">
            {rows.map((ing, i) => {
              const line = draft[ing.id];
              const unit = line?.unit ?? ing.defaultUnit;
              return (
                <div
                  key={ing.id}
                  data-testid={`count-line-${ing.id}`}
                  className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-border" : ""}`}
                >
                  <label htmlFor={`qty-${ing.id}`} className="min-w-0 flex-1 text-sm font-medium">
                    <span className="flex items-center gap-1.5">
                      {isCounted(line) ? (
                        <Check className="size-3.5 shrink-0 text-success" aria-label="Counted" />
                      ) : null}
                      <span className="line-clamp-2">{ing.name}</span>
                    </span>
                  </label>
                  <Input
                    id={`qty-${ing.id}`}
                    aria-label={`${ing.name} quantity`}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="—"
                    value={line?.qty ?? ""}
                    onChange={(e) => update(ing.id, { qty: e.target.value }, ing.defaultUnit)}
                    className="w-20 text-right tabular-nums"
                  />
                  <NativeSelect
                    aria-label={`${ing.name} unit`}
                    value={unit}
                    onChange={(e) => update(ing.id, { unit: e.target.value }, ing.defaultUnit)}
                    className="w-24 shrink-0"
                  >
                    {ing.units.map((u) => (
                      <NativeSelectOption key={u} value={u}>
                        {u}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              );
            })}
          </Card>
        </section>
      ))}

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur md:left-56">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <p className="text-xs text-muted-foreground" role="status">
            {counted} of {ingredients.length} counted
            {saved ? <span data-testid="draft-saved"> · Saved on this device</span> : null}
          </p>
          <Button type="submit" disabled={pending || counted === 0}>
            {pending ? "Submitting…" : "Submit count"}
          </Button>
        </div>
      </div>
    </form>
  );
}
