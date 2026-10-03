"use client";

import { useEffect, useRef, useState, type Dispatch } from "react";
import { notify } from "./notify";
import { AlertTriangle, ArrowRight, History, MapPin, Phone, RotateCcw } from "lucide-react";
import type { CustomerLookup } from "@/lib/orders-server";
import { allItems, draftLine, lineSummary, type Draft, type DraftAction } from "@/lib/pos-client/draft";
import { formatCents } from "@/lib/money";
import { reorderLines } from "@/lib/pricing";
import { formatStoreDateTime } from "@/lib/store-time";
import { cn } from "@/lib/utils";
import { usePos } from "./context";
import { Tap } from "./touch";

const digits = (s: string) => s.replace(/\D/g, "");

type Lookup = { phone: string; state: "loading" } | { phone: string; state: "done"; result: CustomerLookup } | { phone: string; state: "error" };

/**
 * Phone first: the number brings up the caller's name, saved addresses and
 * last orders with one-tap Reorder, re-priced at today's menu.
 */
export function CallerPanel({ draft, dispatch, onContinue }: { draft: Draft; dispatch: Dispatch<DraftAction>; onContinue: () => void }) {
  const { menu, store } = usePos();
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [unavailable, setUnavailable] = useState<{ name: string; reason: string }[]>([]);
  const phoneInput = useRef<HTMLInputElement>(null);
  const phoneDigits = digits(draft.customer.phone);
  const delivery = draft.mode === "delivery";

  useEffect(() => {
    phoneInput.current?.focus();
  }, []);

  useEffect(() => {
    if (phoneDigits.length < 10) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLookup({ phone: phoneDigits, state: "loading" });
      try {
        const res = await fetch(`/api/pos/customers?phone=${phoneDigits}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(String(res.status));
        const result = (await res.json()) as CustomerLookup;
        setLookup({ phone: phoneDigits, state: "done", result });
        if (result.customer) dispatch({ type: "customer", patch: { name: result.customer.name } });
        const addr = result.addresses[0];
        if (addr && delivery) dispatch({ type: "address", address: addr });
      } catch {
        if (!ctrl.signal.aborted) setLookup({ phone: phoneDigits, state: "error" });
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // Only a changed number triggers a lookup; mode changes keep the result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneDigits]);

  const result = lookup?.state === "done" && lookup.phone === phoneDigits ? lookup.result : null;

  const reorder = (order: CustomerLookup["recentOrders"][number]) => {
    const live = order.lines.filter((l) => !l.voided);
    const { lines, unavailable } = reorderLines(live, allItems(menu), menu.policy);
    const items = new Map(allItems(menu).map((i) => [i.id, i]));
    dispatch({
      type: "add",
      lines: lines.map((l) => draftLine(items.get(l.itemId)!, l.selections, l.quantity, l.notes, menu.policy)),
    });
    setUnavailable(unavailable);
    if (unavailable.length > 0) {
      notify.warning(`${unavailable.length} item${unavailable.length > 1 ? "s" : ""} couldn't be reordered`);
    } else {
      notify.success(`Reordered #${order.number}`);
      onContinue();
    }
  };

  const field = "h-12 w-full rounded-xl border bg-background px-3 text-base outline-none focus:ring-3 focus:ring-ring/40";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-2" data-testid="caller-panel">
      <div className="grid grid-cols-[1.2fr_1fr] gap-3">
        <label className="flex flex-col gap-1">
          <span className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
            <Phone className="size-4" /> Phone
          </span>
          <input
            ref={phoneInput}
            inputMode="tel"
            autoComplete="off"
            value={draft.customer.phone}
            onChange={(e) => dispatch({ type: "customer", patch: { phone: e.target.value } })}
            onBlur={(e) => {
              const d = digits(e.target.value);
              if (d.length === 10) dispatch({ type: "customer", patch: { phone: `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` } });
            }}
            placeholder="(555) 010-2233"
            aria-label="Caller phone"
            className={cn(field, "h-14 text-2xl tracking-wide tabular-nums")}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-muted-foreground">Name</span>
          <input
            value={draft.customer.name}
            onChange={(e) => dispatch({ type: "customer", patch: { name: e.target.value } })}
            aria-label="Caller name"
            className={cn(field, "h-14 text-xl")}
          />
        </label>
      </div>

      <p className="-mt-2 h-5 text-sm text-muted-foreground">
        {phoneDigits.length < 10
          ? "Type the number; history appears at 10 digits."
          : lookup?.state === "loading"
            ? "Looking up…"
            : lookup?.state === "error"
              ? "Lookup failed. You can still take the order."
              : result?.customer
                ? `Returning customer · ${result.recentOrders.length} recent order${result.recentOrders.length === 1 ? "" : "s"}`
                : result
                  ? "New customer"
                  : ""}
      </p>

      {delivery && (
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            <MapPin className="size-4" /> Delivery address
          </h3>
          {result && result.addresses.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {result.addresses.map((a) => {
                const on = a.line1 === draft.address.line1 && a.zip === draft.address.zip;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => dispatch({ type: "address", address: a })}
                    className={cn("rounded-xl border px-3 py-2 text-left text-sm", on ? "border-primary bg-primary/10" : "hover:bg-muted")}
                  >
                    <span className="font-medium">{a.line1}</span>
                    {a.line2 && <span> · {a.line2}</span>}
                    <span className="text-muted-foreground"> · {a.zip}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="grid grid-cols-[2fr_1fr] gap-2">
            <input className={field} placeholder="Street address" aria-label="Street address" value={draft.address.line1} onChange={(e) => dispatch({ type: "address", address: { ...draft.address, line1: e.target.value } })} />
            <input className={field} placeholder="Apt / gate / notes" aria-label="Address line 2" value={draft.address.line2 ?? ""} onChange={(e) => dispatch({ type: "address", address: { ...draft.address, line2: e.target.value || null } })} />
            <input className={field} placeholder="City" aria-label="City" value={draft.address.city ?? ""} onChange={(e) => dispatch({ type: "address", address: { ...draft.address, city: e.target.value || null } })} />
            <input className={field} placeholder="ZIP" aria-label="ZIP" inputMode="numeric" value={draft.address.zip} onChange={(e) => dispatch({ type: "address", address: { ...draft.address, zip: e.target.value } })} />
          </div>
        </section>
      )}

      {unavailable.length > 0 && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alert">
          <p className="flex items-center gap-2 font-semibold text-destructive">
            <AlertTriangle className="size-4" /> Not added: tell the caller
          </p>
          <ul className="mt-1 list-disc pl-5">
            {unavailable.map((u, i) => (
              <li key={i}>{u.reason.includes(u.name) ? u.reason : `${u.name}: ${u.reason}`}</li>
            ))}
          </ul>
        </div>
      )}

      {result && result.recentOrders.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            <History className="size-4" /> Last orders
          </h3>
          {result.recentOrders.map((o) => (
            <div key={o.id} className="flex items-center gap-3 rounded-xl border bg-card p-3" data-testid="recent-order">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-muted-foreground">
                  #{o.number} · {formatStoreDateTime(o.placedAt, store.timeZone)} · {formatCents(o.totals.totalCents)}
                </p>
                <p className="truncate font-medium">
                  {o.lines
                    .filter((l) => !l.voided)
                    .map((l) => `${l.quantity} × ${l.name}${l.modifiers.length ? ` (${lineSummary(l.modifiers)})` : ""}`)
                    .join(", ")}
                </p>
              </div>
              <Tap variant="secondary" onClick={() => reorder(o)}>
                <RotateCcw className="size-4" /> Reorder
              </Tap>
            </div>
          ))}
        </section>
      )}

      <div className="mt-auto flex justify-end">
        <Tap onClick={onContinue} variant="outline">
          Menu <ArrowRight className="size-4" />
        </Tap>
      </div>
    </div>
  );
}
