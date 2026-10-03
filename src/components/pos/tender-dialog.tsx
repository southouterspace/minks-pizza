"use client";

import { useState } from "react";
import { Banknote, CreditCard, Printer, Users } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { TenderInput } from "@/lib/orders";
import { splitEvenly } from "@/lib/pricing";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import { Segmented, Tap } from "./touch";

/** "12.5" → 1250; null when it isn't money. */
export function parseCents(s: string): number | null {
  const t = s.replace(/[$,\s]/g, "");
  if (!/^\d*(\.\d{0,2})?$/.test(t) || t === "" || t === ".") return null;
  return Math.round(Number(t) * 100);
}

const QUICK_CASH = [2000, 5000, 10000];

type Method = "cash" | "card_external";

export type TenderOutcome = { dueCents: number } | null;

/**
 * Takes payment against a balance: cash with quick bills and change due,
 * card on the external terminal (amount, tip, last 4), several tenders in a
 * row, and an even split into N shares. `onTender` applies one tender and
 * reports what is still due, or null if it failed (the caller has said why).
 */
export function TenderDialog({
  open,
  title,
  dueCents,
  onTender,
  onPayLater,
  onReceipt,
  onClose,
}: {
  open: boolean;
  title: string;
  dueCents: number;
  onTender: (t: TenderInput) => Promise<TenderOutcome>;
  onPayLater?: () => void;
  onReceipt: () => void;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<Method>("cash");
  const [split, setSplit] = useState<{ shares: number[]; paid: number } | null>(null);
  const [cashText, setCashText] = useState("");
  const [card, setCard] = useState({ amount: "", tip: "", last4: "" });
  const [busy, setBusy] = useState(false);
  const [change, setChange] = useState<number | null>(null);
  const [due, setDue] = useState(dueCents);
  const [paidOff, setPaidOff] = useState(false);

  const share = split && split.paid < split.shares.length ? split.shares[split.paid] : null;
  const applying = Math.min(due, share ?? due);

  const apply = async (t: Omit<TenderInput, "id">) => {
    setBusy(true);
    const out = await onTender({ ...t, id: crypto.randomUUID() });
    setBusy(false);
    if (!out) return;
    setDue(out.dueCents);
    setCashText("");
    setCard({ amount: "", tip: "", last4: "" });
    if (split) setSplit({ ...split, paid: split.paid + 1 });
    if (out.dueCents <= 0) setPaidOff(true);
  };

  const cash = (tenderedCents: number) => {
    const amountCents = Math.min(applying, tenderedCents);
    setChange(tenderedCents - amountCents);
    void apply({ method: "cash", amountCents, tenderedCents, tipCents: 0, last4: null });
  };

  const cardAmount = parseCents(card.amount) ?? applying;
  const cardTip = parseCents(card.tip) ?? 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="w-[min(640px,calc(100vw-2rem))] gap-5 sm:max-w-none" data-testid="tender-dialog">
        <DialogHeader>
          <DialogTitle className="text-xl">{title}</DialogTitle>
        </DialogHeader>

        {paidOff ? (
          <div className="flex flex-col items-center gap-4 py-4" data-testid="paid">
            <p className="text-lg text-muted-foreground">Paid in full</p>
            {change !== null && change > 0 ? (
              <p className="text-5xl font-bold tabular-nums" data-testid="change-due">
                Change {formatCents(change)}
              </p>
            ) : (
              <p className="text-3xl font-semibold">No change due</p>
            )}
            <div className="grid w-full grid-cols-2 gap-3">
              <Tap variant="outline" onClick={onReceipt}>
                <Printer className="size-5" /> Receipt
              </Tap>
              <Tap onClick={onClose} data-testid="tender-done">
                Done
              </Tap>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-sm text-muted-foreground">{share !== null ? `Guest ${split!.paid + 1} of ${split!.shares.length}` : "Balance due"}</p>
                <p className="text-4xl font-bold tabular-nums" data-testid="tender-due">
                  {formatCents(applying)}
                </p>
                {share !== null && <p className="text-sm text-muted-foreground">of {formatCents(due)} left on the check</p>}
                {change !== null && change > 0 && <p className="mt-1 text-lg font-semibold text-success">Last change: {formatCents(change)}</p>}
              </div>
              <div className="flex items-center gap-1">
                <Users className="mr-1 size-4 text-muted-foreground" />
                {[1, 2, 3, 4].map((n) => (
                  <button
                    key={n}
                    type="button"
                    data-split={n}
                    onClick={() => setSplit(n === 1 ? null : { shares: splitEvenly(due, n), paid: 0 })}
                    className={cn(
                      "size-11 rounded-lg border text-base font-semibold",
                      (split?.shares.length ?? 1) === n ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
                    )}
                    aria-label={n === 1 ? "No split" : `Split ${n} ways`}
                  >
                    {n === 1 ? "1" : `÷${n}`}
                  </button>
                ))}
              </div>
            </div>

            <Segmented<Method>
              value={method}
              options={[
                { value: "cash", label: "Cash" },
                { value: "card_external", label: "Card (terminal)" },
              ]}
              onChange={setMethod}
            />

            {method === "cash" ? (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-4 gap-2">
                  <Tap variant="secondary" className="h-16 text-lg" disabled={busy} onClick={() => cash(applying)} data-testid="cash-exact">
                    Exact
                  </Tap>
                  {QUICK_CASH.map((c) => (
                    <Tap key={c} variant="secondary" className="h-16 text-lg" disabled={busy} onClick={() => cash(c)} data-cash={c / 100}>
                      {formatCents(c).replace(".00", "")}
                    </Tap>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    inputMode="decimal"
                    value={cashText}
                    onChange={(e) => setCashText(e.target.value)}
                    onKeyDown={(e) => {
                      const c = parseCents(cashText);
                      if (e.key === "Enter" && c) cash(c);
                    }}
                    placeholder="Other amount handed over"
                    aria-label="Cash handed over"
                    className="h-12 flex-1 rounded-xl border bg-background px-3 text-lg outline-none focus:ring-3 focus:ring-ring/40"
                  />
                  <Tap disabled={busy || !parseCents(cashText)} onClick={() => cash(parseCents(cashText)!)}>
                    <Banknote className="size-5" /> Take cash
                  </Tap>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-3 gap-2">
                  <label className="flex flex-col gap-1 text-sm text-muted-foreground">
                    Amount
                    <input inputMode="decimal" value={card.amount} placeholder={(applying / 100).toFixed(2)} onChange={(e) => setCard({ ...card, amount: e.target.value })} aria-label="Card amount" className="h-12 rounded-xl border bg-background px-3 text-lg text-foreground outline-none" />
                  </label>
                  <label className="flex flex-col gap-1 text-sm text-muted-foreground">
                    Tip
                    <input inputMode="decimal" value={card.tip} placeholder="0.00" onChange={(e) => setCard({ ...card, tip: e.target.value })} aria-label="Card tip" className="h-12 rounded-xl border bg-background px-3 text-lg text-foreground outline-none" />
                  </label>
                  <label className="flex flex-col gap-1 text-sm text-muted-foreground">
                    Last 4 (optional)
                    <input inputMode="numeric" maxLength={4} value={card.last4} onChange={(e) => setCard({ ...card, last4: e.target.value.replace(/\D/g, "") })} aria-label="Card last 4" className="h-12 rounded-xl border bg-background px-3 text-lg text-foreground outline-none" />
                  </label>
                </div>
                <Tap
                  className="h-14 text-lg"
                  disabled={busy || cardAmount <= 0 || cardAmount > due || (card.last4 !== "" && card.last4.length !== 4)}
                  onClick={() => {
                    setChange(null);
                    void apply({ method: "card_external", amountCents: cardAmount, tenderedCents: null, tipCents: cardTip, last4: card.last4 || null });
                  }}
                  data-testid="card-record"
                >
                  <CreditCard className="size-5" /> Card approved on terminal · {formatCents(cardAmount + cardTip)}
                </Tap>
                <p className="text-xs text-muted-foreground">Run the card on the separate terminal first, then record it here.</p>
              </div>
            )}

            {onPayLater && (
              <Tap variant="ghost" onClick={onPayLater} disabled={busy} data-testid="pay-later">
                {due < dueCents ? "Send with the rest unpaid" : "Pay later (at pickup / on delivery)"}
              </Tap>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
