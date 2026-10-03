"use client";

import type { Dispatch } from "react";
import { Clock, Copy, Minus, Pencil, Plus, Trash2, X } from "lucide-react";
import { draftProblem, draftTotals, isPhoneFirst, lineSummary, MODES, type Draft, type DraftAction, type DraftLine, type Mode } from "@/lib/pos-client/draft";
import { formatCents } from "@/lib/money";
import { formatStoreTime, nextStoreTime, storeHhmm } from "@/lib/store-time";
import { cn } from "@/lib/utils";
import { usePos } from "./context";
import { Segmented, Tap } from "./touch";

export function OrderPanel({
  draft,
  dispatch,
  busy,
  onEditLine,
  onShowCaller,
  onSend,
  onPay,
}: {
  draft: Draft;
  dispatch: Dispatch<DraftAction>;
  busy: boolean;
  onEditLine: (line: DraftLine) => void;
  onShowCaller: () => void;
  onSend: () => void;
  onPay: () => void;
}) {
  const { menu, board, now, store } = usePos();
  const timeOf = (at: Date) => formatStoreTime(at, store.timeZone);
  const totals = draftTotals(draft, menu);
  const problem = draftProblem(draft);
  const quote = draft.mode === "delivery" ? board?.quote.deliveryMinutes : board?.quote.pickupMinutes;
  const appending = draft.appendTo !== null;
  const sendLabel = appending ? "Send to check" : draft.schedule.kind === "hold" ? "Hold check" : draft.schedule.kind === "later" ? "Schedule" : "Send";

  return (
    <aside className="flex h-full min-h-0 w-[min(400px,38vw)] shrink-0 flex-col border-l bg-card" data-testid="order-panel">
      <div className="flex flex-col gap-2 border-b p-3">
        {appending ? (
          <div className="flex items-center justify-between rounded-xl bg-primary/10 px-3 py-2">
            <span className="font-semibold">Adding to #{draft.appendTo!.number} · {draft.appendTo!.label}</span>
            <button type="button" className="rounded-lg p-2 hover:bg-background" onClick={() => dispatch({ type: "reset", mode: "walk_in" })} aria-label="Stop adding to this check">
              <X className="size-4" />
            </button>
          </div>
        ) : (
          <Segmented<Mode>
            value={draft.mode}
            options={MODES.map((m) => ({ value: m.mode, label: m.label }))}
            onChange={(mode) => {
              dispatch({ type: "mode", mode });
              if (isPhoneFirst(mode)) onShowCaller();
            }}
            size="sm"
          />
        )}
        {!appending && isPhoneFirst(draft.mode) && (
          <button type="button" onClick={onShowCaller} className="flex items-center justify-between rounded-xl border px-3 py-2 text-left hover:bg-muted" data-testid="caller-summary">
            <span className="min-w-0">
              <span className="block truncate font-medium">{draft.customer.name || "Caller name"} · {draft.customer.phone || "phone"}</span>
              {draft.mode === "delivery" && (
                <span className="block truncate text-sm text-muted-foreground">{draft.address.line1 ? `${draft.address.line1}, ${draft.address.zip}` : "No address yet"}</span>
              )}
            </span>
            <Pencil className="size-4 shrink-0 text-muted-foreground" />
          </button>
        )}
        {!appending && draft.mode === "dine_in" && (
          <div className="flex items-center gap-2">
            <label className="flex flex-1 items-center gap-2">
              <span className="text-sm font-medium text-muted-foreground">Table</span>
              <input
                value={draft.table}
                onChange={(e) => dispatch({ type: "table", table: e.target.value })}
                aria-label="Table"
                className="h-11 w-full rounded-xl border bg-background px-3 text-base outline-none focus:ring-3 focus:ring-ring/40"
              />
            </label>
            <Segmented
              value={draft.schedule.kind === "hold" ? "hold" : "asap"}
              options={[
                { value: "asap", label: "Fire" },
                { value: "hold", label: "Hold" },
              ]}
              onChange={(v) => dispatch({ type: "schedule", schedule: v === "hold" ? { kind: "hold" } : { kind: "asap" } })}
              size="sm"
              className="w-40"
            />
          </div>
        )}
      </div>

      <ol className="min-h-0 flex-1 divide-y overflow-y-auto" data-testid="draft-lines">
        {draft.lines.length === 0 && <li className="p-6 text-center text-muted-foreground">No items yet.</li>}
        {draft.lines.map((l) => (
          <li key={l.lineId} className="flex gap-2 p-3" data-testid="draft-line">
            <div className="flex flex-col items-center gap-1">
              <button type="button" className="flex size-9 items-center justify-center rounded-lg bg-muted" onClick={() => dispatch({ type: "qty", lineId: l.lineId, delta: 1 })} aria-label={`More ${l.name}`}>
                <Plus className="size-4" />
              </button>
              <span className="text-lg font-semibold tabular-nums">{l.quantity}</span>
              <button type="button" className="flex size-9 items-center justify-center rounded-lg bg-muted" onClick={() => dispatch({ type: "qty", lineId: l.lineId, delta: -1 })} aria-label={`Fewer ${l.name}`}>
                <Minus className="size-4" />
              </button>
            </div>
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onEditLine(l)}>
              <span className="flex justify-between gap-2">
                <span className="font-semibold">{l.name}</span>
                <span className="tabular-nums">{formatCents(l.unitPriceCents * l.quantity)}</span>
              </span>
              {l.modifiers.length > 0 && <span className="block text-sm text-muted-foreground" data-testid="line-summary">{lineSummary(l.modifiers)}</span>}
              {l.notes && <span className="block text-sm text-warning italic">“{l.notes}”</span>}
            </button>
            <div className="flex flex-col gap-1">
              <button type="button" className="flex size-9 items-center justify-center rounded-lg hover:bg-muted" onClick={() => dispatch({ type: "repeat", lineId: l.lineId })} aria-label={`Repeat ${l.name}`}>
                <Copy className="size-4" />
              </button>
              <button type="button" className="flex size-9 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10" onClick={() => dispatch({ type: "remove", lineId: l.lineId })} aria-label={`Remove ${l.name}`}>
                <Trash2 className="size-4" />
              </button>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-2 border-t p-3">
        {!appending && isPhoneFirst(draft.mode) && quote !== undefined && (
          <div className="flex items-center gap-2">
            <Segmented
              value={draft.schedule.kind === "later" ? "later" : "asap"}
              options={[
                { value: "asap", label: "ASAP" },
                { value: "later", label: "Later" },
              ]}
              onChange={(v) =>
                dispatch({
                  type: "schedule",
                  schedule: v === "later" ? { kind: "later", readyAt: new Date(Math.ceil((now + (quote + 60) * 60_000) / 900_000) * 900_000).toISOString() } : { kind: "asap" },
                })
              }
              size="sm"
              className="w-36 shrink-0"
            />
            {draft.schedule.kind === "later" ? (
              <input
                type="time"
                aria-label="Ready at"
                value={storeHhmm(draft.schedule.readyAt, store.timeZone)}
                onChange={(e) => e.target.value && dispatch({ type: "schedule", schedule: { kind: "later", readyAt: nextStoreTime(e.target.value, new Date(), store.timeZone).toISOString() } })}
                className="h-11 min-w-0 flex-1 rounded-lg border bg-background px-2 text-base"
              />
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-1 text-sm whitespace-nowrap" data-testid="quote">
                <Clock className="size-4 shrink-0" />
                <b>{quote} min</b>
                <span className="truncate text-muted-foreground">· ready ~{timeOf(new Date(now + quote * 60_000))}</span>
              </span>
            )}
          </div>
        )}
        {!appending && draft.schedule.kind === "later" && quote !== undefined && (
          <p className="-mt-1 text-sm text-muted-foreground">
            Kitchen starts it at {timeOf(new Date(Date.parse(draft.schedule.readyAt) - quote * 60_000))} ({quote} min quote). Held until then.
          </p>
        )}
        {!appending && (
          <input
            value={draft.notes}
            onChange={(e) => dispatch({ type: "notes", notes: e.target.value })}
            placeholder="Order note (gate code, allergy…)"
            aria-label="Order note"
            className="h-10 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-3 focus:ring-ring/40"
          />
        )}
        <dl className="grid grid-cols-2 gap-y-0.5 text-sm tabular-nums" data-testid="totals">
          <dt className="text-muted-foreground">Subtotal</dt>
          <dd className="text-right">{formatCents(totals.subtotalCents)}</dd>
          <dt className="text-muted-foreground">Tax</dt>
          <dd className="text-right">{formatCents(totals.taxCents)}</dd>
          {totals.deliveryFeeCents > 0 && (
            <>
              <dt className="text-muted-foreground">Delivery</dt>
              <dd className="text-right">{formatCents(totals.deliveryFeeCents)}</dd>
            </>
          )}
          <dt className="text-lg font-semibold">{appending ? "Adds" : "Total"}</dt>
          <dd className="text-right text-lg font-semibold" data-testid="draft-total">
            {formatCents(totals.totalCents)}
          </dd>
        </dl>
        <p className={cn("min-h-5 text-sm text-muted-foreground", !problem && "invisible")}>{problem ?? "."}</p>
        <div className="grid grid-cols-2 gap-2">
          <Tap variant="outline" disabled={!!problem || busy} onClick={onSend} data-testid="send">
            {sendLabel}
          </Tap>
          <Tap disabled={!!problem || busy || appending} onClick={onPay} data-testid="pay">
            Pay {formatCents(totals.totalCents)}
          </Tap>
        </div>
      </div>
    </aside>
  );
}
