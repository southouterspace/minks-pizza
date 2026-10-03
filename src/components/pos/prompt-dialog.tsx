"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { TenderMethod } from "@/lib/orders";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import { parseCents } from "./tender-dialog";
import { Segmented, Tap } from "./touch";

export type PromptSpec = {
  title: string;
  description?: string;
  confirm: string;
  destructive?: boolean;
  reasons: string[];
  /** Ask for an amount, capped at `max` cents. */
  amount?: { max: number; initial?: number };
  method?: boolean;
  onSubmit: (v: { reason: string; cents: number; method: TenderMethod }) => void;
};

/** Reason (one-tap presets or typed), and optionally an amount and a method. */
export function PromptDialog({ spec, onClose }: { spec: PromptSpec; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState(spec.amount?.initial ? (spec.amount.initial / 100).toFixed(2) : "");
  const [method, setMethod] = useState<TenderMethod>("cash");
  const cents = spec.amount ? parseCents(amount) : 0;
  const amountOk = !spec.amount || (cents !== null && cents > 0 && cents <= spec.amount.max);
  const ok = reason.trim().length > 0 && amountOk;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(520px,calc(100vw-2rem))] gap-4 sm:max-w-none!" data-testid="prompt-dialog">
        <DialogHeader>
          <DialogTitle className="text-lg">{spec.title}</DialogTitle>
          {spec.description && <DialogDescription>{spec.description}</DialogDescription>}
        </DialogHeader>
        {spec.amount && (
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Amount (up to {formatCents(spec.amount.max)})
            <input inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" className="h-12 rounded-xl border bg-background px-3 text-xl text-foreground outline-none focus:ring-3 focus:ring-ring/40" />
          </label>
        )}
        {spec.method && (
          <Segmented<TenderMethod>
            value={method}
            options={[
              { value: "cash", label: "Cash back" },
              { value: "card_external", label: "Card (terminal)" },
            ]}
            onChange={setMethod}
          />
        )}
        <div className="flex flex-wrap gap-2">
          {spec.reasons.map((r) => (
            <button key={r} type="button" onClick={() => setReason(r)} className={cn("h-11 rounded-xl border px-3 text-sm", reason === r ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
              {r}
            </button>
          ))}
        </div>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus={!spec.amount}
          placeholder="Reason"
          aria-label="Reason"
          className="h-12 rounded-xl border bg-background px-3 text-base outline-none focus:ring-3 focus:ring-ring/40"
        />
        <div className="grid grid-cols-2 gap-2">
          <Tap variant="outline" onClick={onClose}>
            Back
          </Tap>
          <Tap
            variant={spec.destructive ? "destructive" : "default"}
            disabled={!ok}
            data-testid="prompt-confirm"
            onClick={() => {
              onClose();
              spec.onSubmit({ reason: reason.trim(), cents: cents ?? 0, method });
            }}
          >
            {spec.confirm}
          </Tap>
        </div>
      </DialogContent>
    </Dialog>
  );
}
