"use client";

import { useState } from "react";
import { Banknote, CreditCard, Printer, Users } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { digitsOf, type TenderInput } from "@/lib/orders";
import { shareByItem, splitEvenly } from "@/lib/pricing";
import { formatCents, parseCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import { Segmented, Tap } from "./touch";

const QUICK_CASH = [2000, 5000, 10000];

type Method = "cash" | "card_external";

export type TenderOutcome = { dueCents: number } | null;

/** A check line as the split sees it: what it costs after its own comps and discounts. */
export type SplitLine = { lineId: string; label: string; cents: number };

/**
 * `due` is the balance when the split started; shares are worked out against
 * it and frozen into `base` once the first guest pays, so later guests owe
 * what the screen showed them. `next` is the first guest who hasn't paid.
 */
type Split = { guests: number; due: number; byItem: Record<string, number[]>; base: number[] | null; next: number };

function splitShares(split: Split, lines: readonly SplitLine[]): { guest: number; cents: number }[] {
  const cents =
    split.base ??
    (lines.some((l) => (split.byItem[l.lineId] ?? []).length > 0)
      ? shareByItem(split.due, split.guests, lines.map((l) => ({ cents: l.cents, guests: split.byItem[l.lineId] ?? [] })))
      : splitEvenly(split.due, split.guests));
  return cents.map((c, guest) => ({ guest, cents: c }));
}

/**
 * Takes payment against a balance: cash with quick bills and change due,
 * card on the external terminal (amount, tip, last 4), several tenders in a
 * row, and a split into N guests: even, or by item when `lines` is given, with
 * any line shared by several guests. `onTender` applies one tender and
 * reports what is still due, or null if it failed (the caller has said why).
 */
export function TenderDialog({
  open,
  title,
  dueCents,
  onTender,
  lines,
  onPayLater,
  onReceipt,
  onClose,
}: {
  open: boolean;
  title: string;
  dueCents: number;
  lines?: SplitLine[];
  onTender: (t: TenderInput) => Promise<TenderOutcome>;
  onPayLater?: () => void;
  onReceipt: () => void;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<Method>("cash");
  const [split, setSplit] = useState<Split | null>(null);
  const [cashText, setCashText] = useState("");
  const [card, setCard] = useState({ amount: "", tip: "", last4: "" });
  const [busy, setBusy] = useState(false);
  const [change, setChange] = useState<number | null>(null);
  const [due, setDue] = useState(dueCents);
  const [paidOff, setPaidOff] = useState(false);

  const shares = split ? splitShares(split, lines ?? []) : null;
  const turn = shares?.find((s) => s.cents > 0 && s.guest >= (split?.next ?? 0)) ?? null;
  const share = turn?.cents ?? null;
  const applying = Math.min(due, share ?? due);

  const apply = async (t: Omit<TenderInput, "id">) => {
    setBusy(true);
    const out = await onTender({ ...t, id: crypto.randomUUID() });
    setBusy(false);
    if (!out) return;
    setDue(out.dueCents);
    setCashText("");
    setCard({ amount: "", tip: "", last4: "" });
    if (split && turn) setSplit({ ...split, base: shares!.map((s) => s.cents), next: turn.guest + 1 });
    if (out.dueCents <= 0) setPaidOff(true);
  };

  const cash = (tenderedCents: number) => {
    const amountCents = Math.min(applying, tenderedCents);
    setChange(tenderedCents - amountCents);
    void apply({ method: "cash", amountCents, tenderedCents, tipCents: 0, last4: null });
  };

  const typedCash = parseCents(cashText);
  const cardAmount = parseCents(card.amount) ?? applying;
  const cardTip = parseCents(card.tip) ?? 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="w-[min(640px,calc(100vw-2rem))] gap-5 sm:max-w-none!" data-testid="tender-dialog">
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
                <p className="text-sm text-muted-foreground">{turn ? `Guest ${turn.guest + 1} of ${split!.guests}` : "Balance due"}</p>
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
                    disabled={busy || (split?.next ?? 0) > 0}
                    onClick={() => setSplit(n === 1 ? null : { guests: n, due, byItem: split?.byItem ?? {}, base: null, next: 0 })}
                    className={cn(
                      "size-11 rounded-lg border text-base font-semibold disabled:opacity-50",
                      (split?.guests ?? 1) === n ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
                    )}
                    aria-label={n === 1 ? "No split" : `Split ${n} ways`}
                  >
                    {n === 1 ? "1" : `÷${n}`}
                  </button>
                ))}
              </div>
            </div>

            {split && lines && lines.length > 0 && split.next === 0 && (
              <div className="flex flex-col gap-1 rounded-xl border p-2" data-testid="split-by-item">
                <p className="px-1 text-sm text-muted-foreground">Tap who had each item. Untapped items are shared by everyone.</p>
                <ul className="max-h-48 divide-y overflow-y-auto">
                  {lines.map((l) => {
                    const who = split.byItem[l.lineId] ?? [];
                    return (
                      <li key={l.lineId} className="flex items-center gap-2 px-1 py-1">
                        <span className="min-w-0 flex-1 truncate">{l.label}</span>
                        <span className="text-sm text-muted-foreground tabular-nums">{who.length === 0 ? "shared" : formatCents(l.cents)}</span>
                        {Array.from({ length: split.guests }, (_, g) => (
                          <button
                            key={g}
                            type="button"
                            aria-pressed={who.includes(g)}
                            aria-label={`Guest ${g + 1} had ${l.label}`}
                            onClick={() =>
                              setSplit({
                                ...split,
                                byItem: { ...split.byItem, [l.lineId]: who.includes(g) ? who.filter((x) => x !== g) : [...who, g].sort() },
                              })
                            }
                            className={cn("size-10 rounded-lg border text-sm font-semibold", who.includes(g) ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}
                          >
                            {g + 1}
                          </button>
                        ))}
                      </li>
                    );
                  })}
                </ul>
                <p className="px-1 text-sm tabular-nums" data-testid="split-shares">
                  {shares!.map((s) => `Guest ${s.guest + 1} ${formatCents(s.cents)}`).join(" · ")}
                </p>
              </div>
            )}

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
                  <Tap variant="secondary" className="h-16! text-lg!" disabled={busy} onClick={() => cash(applying)} data-testid="cash-exact">
                    Exact
                  </Tap>
                  {QUICK_CASH.map((c) => (
                    <Tap key={c} variant="secondary" className="h-16! text-lg!" disabled={busy} onClick={() => cash(c)} data-cash={c / 100}>
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
                      if (e.key === "Enter" && typedCash) cash(typedCash);
                    }}
                    placeholder="Other amount handed over"
                    aria-label="Cash handed over"
                    className="h-12 flex-1 rounded-xl border bg-background px-3 text-lg outline-none focus:ring-3 focus:ring-ring/40"
                  />
                  <Tap disabled={busy || !typedCash} onClick={() => typedCash && cash(typedCash)}>
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
                    <input inputMode="numeric" maxLength={4} value={card.last4} onChange={(e) => setCard({ ...card, last4: digitsOf(e.target.value) })} aria-label="Card last 4" className="h-12 rounded-xl border bg-background px-3 text-lg text-foreground outline-none" />
                  </label>
                </div>
                <Tap
                  className="h-14! text-lg!"
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
