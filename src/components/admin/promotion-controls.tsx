"use client";

import { useState, useTransition } from "react";
import { Copy, Download, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  addSharedCode,
  archivePromotion,
  deleteCode,
  deletePromotion,
  generateCodes,
  setPromotionActive,
} from "@/app/admin/promotions/actions";
import { displayCode } from "@/lib/promo-code";
import { PROMOTION_STATUS_LABEL } from "@/lib/promotion-copy";
import type { PromotionStatus } from "@/lib/promotion-engine";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<PromotionStatus, string> = {
  active: "border-transparent! bg-success/10 text-success!",
  scheduled: "",
  expired: "text-muted-foreground!",
  paused: "border-transparent! bg-warning/10 text-warning!",
  used_up: "text-muted-foreground!",
  archived: "text-muted-foreground!",
};

export function PromotionStatusBadge({ status }: { status: PromotionStatus }) {
  return (
    <Badge variant="outline" className={STATUS_CLASS[status]} data-testid="promo-status">
      {PROMOTION_STATUS_LABEL[status]}
    </Badge>
  );
}

/** The pause switch: off stops new orders from getting the deal right away. */
export function PauseSwitch({ id, active, name }: { id: number; active: boolean; name: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Switch
      checked={active}
      disabled={pending}
      aria-label={`${active ? "Pause" : "Resume"} ${name}`}
      onCheckedChange={(on) => startTransition(() => setPromotionActive(id, on))}
    />
  );
}

export function ArchiveButtons({ id, archived, used }: { id: number; archived: boolean; used: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => startTransition(() => archivePromotion(id, !archived))}
      >
        {archived ? "Restore" : "Archive"}
      </Button>
      {!used ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          className="text-destructive"
          onClick={() => {
            if (!window.confirm("Delete this deal? It was never used, so nothing else changes.")) return;
            startTransition(async () => {
              const r = await deletePromotion(id);
              if (r?.error) toast.error(r.error);
            });
          }}
        >
          <Trash2 data-icon="inline-start" />
          Delete
        </Button>
      ) : null}
    </div>
  );
}

export type CodeRow = { id: number; display: string; maxUses: number | null; uses: number };

function shareLink(code: string): string {
  return `${window.location.origin}/?promo=${encodeURIComponent(code)}`;
}

export function CodesPanel({
  promotionId,
  codes,
  totalCodes,
}: {
  promotionId: number;
  codes: CodeRow[];
  totalCodes: number;
}) {
  const [pending, startTransition] = useTransition();
  const [code, setCode] = useState("");
  const [count, setCount] = useState("50");
  const [prefix, setPrefix] = useState("MINK");
  const shared = codes.filter((c) => c.maxUses === null);
  const single = codes.filter((c) => c.maxUses !== null);
  const singleUsed = single.filter((c) => c.uses >= (c.maxUses ?? 1)).length;

  const run = (fn: () => Promise<{ error?: string }>, done: string) =>
    startTransition(async () => {
      const r = await fn();
      if (r.error) toast.error(r.error);
      else toast.success(done);
    });

  return (
    <div className="space-y-5">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await addSharedCode(promotionId, code);
            if (!r.error) setCode("");
            return r;
          }, `Code ${displayCode(code)} added`);
        }}
      >
        <Field className="min-w-40 flex-1">
          <FieldLabel htmlFor="shared-code">Shared code</FieldLabel>
          <Input id="shared-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="PIZZA10" className="font-mono uppercase" maxLength={30} required />
        </Field>
        <Button type="submit" variant="outline" disabled={pending}>
          Add code
        </Button>
      </form>

      {shared.length ? (
        <ul className="divide-y rounded-lg border" data-testid="shared-codes">
          {shared.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span>
                <span className="font-mono font-medium">{c.display}</span>{" "}
                <span className="text-muted-foreground">· used {c.uses}×</span>
              </span>
              <span className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(shareLink(c.display)).catch(() => {});
                    toast.success("Share link copied", { description: shareLink(c.display) });
                  }}
                >
                  <Copy data-icon="inline-start" />
                  Copy link
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete code ${c.display}`}
                  disabled={pending}
                  onClick={() => {
                    if (!window.confirm(`Stop accepting ${c.display}? Orders that used it keep their discount.`)) return;
                    startTransition(() => deleteCode(promotionId, c.id));
                  }}
                >
                  <Trash2 />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => generateCodes(promotionId, Number(count), prefix), `Generated ${count} single-use codes`);
        }}
      >
        <Field className="w-24">
          <FieldLabel htmlFor="gen-count">How many</FieldLabel>
          <Input id="gen-count" type="number" min="1" max="1000" step="1" value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <Field className="w-28">
          <FieldLabel htmlFor="gen-prefix">Prefix</FieldLabel>
          <Input id="gen-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={8} className="font-mono uppercase" />
        </Field>
        <Button type="submit" variant="outline" disabled={pending}>
          Generate single-use codes
        </Button>
      </form>

      {single.length ? (
        <div className="space-y-2 text-sm">
          <p className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {totalCodes - shared.length} single-use codes · {singleUsed} used
              {single.length < totalCodes - shared.length ? ` (first ${single.length} shown)` : ""}
            </span>
            <a
              href={`/api/admin/promotions/${promotionId}/codes`}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              data-testid="codes-csv"
            >
              <Download data-icon="inline-start" />
              Download CSV
            </a>
          </p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-xs sm:grid-cols-4">
            {single.map((c) => (
              <li key={c.id} className={cn(c.uses >= (c.maxUses ?? 1) && "text-muted-foreground line-through")}>
                {c.display}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
