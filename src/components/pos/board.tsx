"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { channelLabel, digitsOf, dueCents, PAYMENT_LABEL, paymentState, type KitchenStatus, type OrderView } from "@/lib/orders";
import { formatCents } from "@/lib/money";
import { formatStoreTime } from "@/lib/store-time";
import { cn } from "@/lib/utils";
import { usePos } from "./context";
import { Segmented } from "./touch";

export const STATUS_LABEL: Record<KitchenStatus, string> = {
  held: "Held",
  new: "Sent",
  preparing: "Making",
  ready: "Ready",
  completed: "Done",
  canceled: "Canceled",
};

const STATUS_TONE: Record<KitchenStatus, string> = {
  held: "bg-muted text-muted-foreground",
  new: "bg-primary/10 text-foreground",
  preparing: "bg-warning/15 text-warning",
  ready: "bg-success/15 text-success",
  completed: "bg-muted text-muted-foreground",
  canceled: "bg-destructive/10 text-destructive",
};

type Lane = "all" | "scheduled" | "kitchen" | "ready" | "unpaid";

const LANES: { value: Lane; label: string; test: (o: OrderView) => boolean }[] = [
  { value: "all", label: "All", test: () => true },
  { value: "scheduled", label: "Held", test: (o) => o.status === "held" },
  { value: "kitchen", label: "Kitchen", test: (o) => o.status === "new" || o.status === "preparing" },
  { value: "ready", label: "Ready", test: (o) => o.status === "ready" },
  { value: "unpaid", label: "Unpaid", test: (o) => dueCents(o.totals) > 0 },
];

export function StatusChip({ status }: { status: KitchenStatus }) {
  return <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold uppercase", STATUS_TONE[status])}>{STATUS_LABEL[status]}</span>;
}

export function PaymentChip({ order }: { order: OrderView }) {
  const state = paymentState(order.totals);
  return (
    <Badge variant={state === "paid" ? "secondary" : state === "refunded" ? "destructive" : "outline"} className={cn(state === "unpaid" && "border-warning text-warning")}>
      {PAYMENT_LABEL[state]}
    </Badge>
  );
}

export function orderLabel(o: OrderView): string {
  return o.fulfillment.kind === "dine_in" ? `Table ${o.fulfillment.table}` : o.customer.name;
}

export function OrdersBoard() {
  const { board, openOrder, store } = usePos();
  const clock = (iso: string) => formatStoreTime(iso, store.timeZone);
  const [lane, setLane] = useState<Lane>("all");
  const [query, setQuery] = useState("");
  const orders = board.openOrders;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qDigits = digitsOf(q);
    const test = LANES.find((l) => l.value === lane)!.test;
    return orders.filter(
      (o) =>
        test(o) &&
        (!q ||
          orderLabel(o).toLowerCase().includes(q) ||
          String(o.number) === q.replace(/^#/, "") ||
          (qDigits.length >= 3 && digitsOf(o.customer.phone).includes(qDigits))),
    );
  }, [orders, lane, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="board">
      <div className="flex items-center gap-2">
        <Segmented<Lane>
          value={lane}
          options={LANES.map((l) => ({ value: l.value, label: `${l.label} ${orders.filter(l.test).length}` }))}
          onChange={setLane}
          size="sm"
          className="min-w-0 flex-1"
        />
        <label className="relative flex w-44 shrink-0 items-center">
          <Search className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, phone, #"
            aria-label="Search open orders"
            className="h-11 w-full rounded-xl border bg-background pr-3 pl-9 text-base outline-none focus:ring-3 focus:ring-ring/40"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border bg-card">
        {shown.length === 0 && <p className="p-10 text-center text-muted-foreground">No open orders{query ? ` match “${query}”` : ""}.</p>}
        <ul className="divide-y">
          {shown.map((o) => (
            <li key={o.id}>
              <button type="button" onClick={() => openOrder(o.id)} className="grid w-full grid-cols-[4rem_1fr_auto_auto] items-center gap-3 px-4 py-3 text-left hover:bg-muted/60" data-order={o.number}>
                <span className="text-xl font-bold tabular-nums">#{o.number}</span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <Badge variant="outline">{channelLabel(o.channel, o.fulfillment.kind)}</Badge>
                    {o.fulfillment.kind === "delivery" && <Badge variant="outline">Delivery</Badge>}
                    <span className="truncate font-semibold">{orderLabel(o)}</span>
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {o.customer.phone && `${o.customer.phone} · `}
                    {o.lines.filter((l) => !l.voided).map((l) => `${l.quantity} × ${l.name}`).join(", ")}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  <StatusChip status={o.status} />
                  <span className="text-xs text-muted-foreground">
                    {o.status === "held" && o.fireAt ? `fires ${clock(o.fireAt)}` : o.promisedAt ? `due ${clock(o.promisedAt)}` : ""}
                  </span>
                </span>
                <span className="flex w-24 flex-col items-end gap-1">
                  <PaymentChip order={o} />
                  <span className="text-sm tabular-nums">{formatCents(dueCents(o.totals) || o.totals.totalCents)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
