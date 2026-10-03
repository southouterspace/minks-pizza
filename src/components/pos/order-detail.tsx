"use client";

import { useState } from "react";
import { ArrowLeft, Ban, Flame, Gift, HandPlatter, History, Percent, Plus, Printer, Scissors, Undo2, Wallet, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { mutateOrderAction } from "@/app/pos/actions";
import { channelLabel, dueCents, orderHistory, requiredRole, type LineView, type OrderMutation, type OrderView } from "@/lib/orders";
import { lineSummary } from "@/lib/pos-client/draft";
import { formatCents } from "@/lib/money";
import { formatStoreTime } from "@/lib/store-time";
import { cn } from "@/lib/utils";
import { PaymentChip, StatusChip, orderLabel } from "./board";
import { usePos } from "./context";
import { PromptDialog, type PromptSpec } from "./prompt-dialog";
import { TenderDialog } from "./tender-dialog";
import { Tap } from "./touch";

const VOID_REASONS = ["Customer changed mind", "Rang in wrong", "Made wrong", "Took too long"];
const COMP_REASONS = ["Made wrong", "Long wait", "Regular / goodwill", "Staff meal"];
const DISCOUNT_REASONS = ["Coupon", "Manager special", "Long wait", "Employee"];
const REFUND_REASONS = ["Order wrong", "Never received", "Overcharged", "Canceled"];

/**
 * One order, any channel: collect payment, add to the check, fire held
 * lines, void, comp, discount, split, refund, cancel, hand off, reprint, and
 * who did what. Every verb is one `mutateOrderAction`, resent with a manager
 * PIN when the server asks.
 */
export function OrderDetail({
  order,
  onChange,
  onBack,
  onAddItems,
  onReceipt,
}: {
  order: OrderView;
  onChange: (o: OrderView) => void;
  onBack: () => void;
  onAddItems: (o: OrderView) => void;
  onReceipt: (o: OrderView) => void;
}) {
  const { act, menu, store } = usePos();
  const clock = (iso: string) => formatStoreTime(iso, store.timeZone);
  const [prompt, setPrompt] = useState<PromptSpec | null>(null);
  const [paying, setPaying] = useState(false);
  const [splitting, setSplitting] = useState<Set<string> | null>(null);
  const [showLog, setShowLog] = useState(false);

  const live = order.lines.filter((l) => !l.voided);
  const held = live.filter((l) => !l.firedAt);
  const due = dueCents(order.totals);
  const net = order.totals.paidCents - order.totals.refundedCents;
  const closed = order.status === "canceled" || order.status === "completed";

  const needsManager = (m: OrderMutation) => requiredRole(m, { order, discountApprovalCents: menu.discountApprovalCents }) === "manager";

  const mutate = async (label: string, mutation: OrderMutation): Promise<OrderView | null> => {
    const r = await act(label, (approval) => mutateOrderAction({ orderId: order.id, mutation, approval }));
    if (r) {
      onChange(r.order);
      return r.order;
    }
    return null;
  };

  const voidLine = (l: LineView) =>
    setPrompt({
      title: `Void ${l.quantity} × ${l.name}`,
      description: needsManager({ kind: "void_line", lineId: l.lineId, reason: "" }) ? "Already sent to the kitchen: a manager must approve." : "Not sent yet.",
      confirm: "Void line",
      destructive: true,
      reasons: VOID_REASONS,
      onSubmit: ({ reason }) => void mutate(`Void ${l.name}`, { kind: "void_line", lineId: l.lineId, reason }),
    });

  const compLine = (l: LineView) =>
    setPrompt({
      title: `Comp ${l.quantity} × ${l.name} (${formatCents(l.lineTotalCents)})`,
      description: needsManager({ kind: "comp", id: "", lineId: l.lineId, reason: "" }) ? "Comps need a manager." : undefined,
      confirm: "Comp line",
      reasons: COMP_REASONS,
      onSubmit: ({ reason }) => void mutate(`Comp ${l.name}`, { kind: "comp", id: crypto.randomUUID(), lineId: l.lineId, reason }),
    });

  const discount = () => {
    const id = crypto.randomUUID();
    setPrompt({
      title: "Discount the check",
      description: `Discounts over ${formatCents(menu.discountApprovalCents)} need a manager.`,
      confirm: "Apply discount",
      reasons: DISCOUNT_REASONS,
      amount: { max: order.totals.subtotalCents - order.totals.discountCents },
      onSubmit: ({ reason, cents }) => void mutate(`Discount ${formatCents(cents)}`, { kind: "discount", id, lineId: null, cents, reason }),
    });
  };

  const refund = () => {
    const id = crypto.randomUUID();
    setPrompt({
      title: "Refund",
      description: `Refunds ${needsManager({ kind: "refund", id, method: "cash", amountCents: net, reason: "" }) ? "need a manager and " : ""}come out of this shift's drawer or card batch.`,
      confirm: "Refund",
      destructive: true,
      reasons: REFUND_REASONS,
      amount: { max: net, initial: net > order.totals.totalCents ? net - order.totals.totalCents : net },
      method: true,
      onSubmit: ({ reason, cents, method }) => void mutate(`Refund ${formatCents(cents)}`, { kind: "refund", id, method, amountCents: cents, reason }),
    });
  };

  const cancel = () =>
    setPrompt({
      title: `Cancel order #${order.number}`,
      description: needsManager({ kind: "cancel", reason: "" }) ? "Food has been sent: a manager must approve. Refund any payment separately." : undefined,
      confirm: "Cancel order",
      destructive: true,
      reasons: ["Customer canceled", "Duplicate order", "No-show", "Prank call"],
      onSubmit: ({ reason }) => void mutate("Cancel order", { kind: "cancel", reason }),
    });

  const f = order.fulfillment;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="order-detail">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack} className="rounded-xl p-3 hover:bg-muted" aria-label="Back to open orders">
          <ArrowLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-2xl font-bold">
            #{order.number}
            <span className="truncate text-xl font-semibold">{orderLabel(order)}</span>
          </h2>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">{channelLabel(order.channel, f.kind)}</Badge>
            <StatusChip status={order.status} />
            <PaymentChip order={order} />
            {order.customer.phone && <span>{order.customer.phone}</span>}
            {order.status === "held" && order.fireAt && <span>fires {clock(order.fireAt)}</span>}
            {order.promisedAt && <span>promised {clock(order.promisedAt)}</span>}
          </p>
          {f.kind === "delivery" && (
            <p className="text-sm font-medium">
              {f.address.line1}
              {f.address.line2 ? `, ${f.address.line2}` : ""}, {f.address.zip}
            </p>
          )}
          {order.notes && <p className="text-sm font-medium text-warning">Note: {order.notes}</p>}
        </div>
        <Tap variant="outline" onClick={() => setShowLog((s) => !s)} aria-pressed={showLog}>
          <History className="size-4" /> Log
        </Tap>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border bg-card">
          <ul className="divide-y">
            {order.lines.map((l) => {
              const adj = order.adjustments.filter((a) => a.lineId === l.lineId);
              return (
                <li key={l.lineId} className={cn("flex items-center gap-3 px-4 py-3", l.voided && "opacity-60")} data-line={l.name}>
                  {splitting && !l.voided && (
                    <input
                      type="checkbox"
                      className="size-6"
                      aria-label={`Move ${l.name}`}
                      checked={splitting.has(l.lineId)}
                      onChange={(e) => {
                        const next = new Set(splitting);
                        if (e.target.checked) next.add(l.lineId);
                        else next.delete(l.lineId);
                        setSplitting(next);
                      }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className={cn("font-semibold", l.voided && "line-through")}>
                      {l.quantity} × {l.name}
                      {l.voided && <span className="ml-2 text-sm font-bold text-destructive no-underline">VOID</span>}
                      {!l.voided && !l.firedAt && <span className="ml-2 text-xs font-semibold text-muted-foreground uppercase">held</span>}
                      {!l.voided && l.doneAt && <span className="ml-2 text-xs font-semibold text-success uppercase">done</span>}
                    </p>
                    {l.modifiers.length > 0 && <p className="text-sm text-muted-foreground">{lineSummary(l.modifiers)}</p>}
                    {l.notes && <p className="text-sm text-warning italic">“{l.notes}”</p>}
                    {l.voided && <p className="text-xs text-muted-foreground">{l.voided.reason}</p>}
                    {adj.map((a) => (
                      <p key={a.id} className="text-xs text-success">
                        {a.kind === "comp" ? "Comped" : "Discount"} −{formatCents(a.cents)} · {a.reason}
                      </p>
                    ))}
                  </div>
                  <span className="tabular-nums">{formatCents(l.lineTotalCents)}</span>
                  {!l.voided && !closed && !splitting && (
                    <div className="flex gap-1">
                      {!l.firedAt && (
                        <button type="button" onClick={() => void mutate(`Fire ${l.name}`, { kind: "fire", lineIds: [l.lineId] })} className="flex size-11 items-center justify-center rounded-lg hover:bg-muted" aria-label={`Fire ${l.name}`}>
                          <Flame className="size-5" />
                        </button>
                      )}
                      {adj.length === 0 && (
                        <button type="button" onClick={() => compLine(l)} className="flex size-11 items-center justify-center rounded-lg hover:bg-muted" aria-label={`Comp ${l.name}`}>
                          <Gift className="size-5" />
                        </button>
                      )}
                      <button type="button" onClick={() => voidLine(l)} className="flex size-11 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10" aria-label={`Void ${l.name}`}>
                        <Ban className="size-5" />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <dl className="grid grid-cols-2 gap-y-0.5 border-t px-4 py-3 text-sm tabular-nums">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="text-right">{formatCents(order.totals.subtotalCents)}</dd>
            {order.totals.discountCents > 0 && (
              <>
                <dt className="text-muted-foreground">Discounts</dt>
                <dd className="text-right">−{formatCents(order.totals.discountCents)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Tax</dt>
            <dd className="text-right">{formatCents(order.totals.taxCents)}</dd>
            {order.totals.deliveryFeeCents > 0 && (
              <>
                <dt className="text-muted-foreground">Delivery</dt>
                <dd className="text-right">{formatCents(order.totals.deliveryFeeCents)}</dd>
              </>
            )}
            {order.totals.tipCents > 0 && (
              <>
                <dt className="text-muted-foreground">Tip</dt>
                <dd className="text-right">{formatCents(order.totals.tipCents)}</dd>
              </>
            )}
            <dt className="font-semibold">Total</dt>
            <dd className="text-right font-semibold">{formatCents(order.totals.totalCents)}</dd>
            <dt className="text-muted-foreground">Paid</dt>
            <dd className="text-right">{formatCents(net)}</dd>
            {net > order.totals.totalCents ? (
              <>
                <dt className="text-lg font-bold text-destructive">Refund due</dt>
                <dd className="text-right text-lg font-bold text-destructive">{formatCents(net - order.totals.totalCents)}</dd>
              </>
            ) : (
              <>
                <dt className="text-lg font-bold">Due</dt>
                <dd className="text-right text-lg font-bold" data-testid="order-due">
                  {formatCents(due)}
                </dd>
              </>
            )}
          </dl>
        </div>

        {showLog && (
          <ol className="w-72 shrink-0 space-y-2 overflow-y-auto rounded-2xl border bg-card p-3 text-sm" data-testid="activity-log">
            {orderHistory(order).map((h, i) => (
              <li key={i}>
                <span className="text-xs text-muted-foreground">{clock(h.at)}</span> {h.text}
                {h.who && <span className="text-muted-foreground"> · {h.who}</span>}
                {h.approvedBy && h.approvedBy !== h.who && <span className="text-muted-foreground"> · approved by {h.approvedBy}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>

      {splitting ? (
        <div className="flex items-center gap-2">
          <p className="flex-1 text-sm text-muted-foreground">Pick the lines that move to a new check. The kitchen still sees one ticket.</p>
          <Tap variant="outline" onClick={() => setSplitting(null)}>
            Back
          </Tap>
          <Tap
            disabled={splitting.size === 0 || splitting.size === live.length}
            onClick={async () => {
              const lineIds = [...splitting];
              const done = await mutate("Split check", { kind: "split_by_item", lineIds, newOrderId: crypto.randomUUID() });
              if (done) setSplitting(null);
            }}
          >
            <Scissors className="size-4" /> Move {splitting.size} to new check
          </Tap>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2" data-testid="order-actions">
          {!closed && due > 0 && (
            <Tap onClick={() => setPaying(true)} className="min-w-36" data-testid="order-pay">
              <Wallet className="size-5" /> Pay {formatCents(due)}
            </Tap>
          )}
          {!closed && (
            <Tap variant="secondary" onClick={() => onAddItems(order)}>
              <Plus className="size-4" /> Add items
            </Tap>
          )}
          {!closed && held.length > 0 && (
            <Tap variant="secondary" onClick={() => void mutate("Fire", { kind: "fire", lineIds: "all" })} data-testid="fire-all">
              <Flame className="size-4" /> Fire {held.length} held
            </Tap>
          )}
          {order.status === "ready" && (
            <Tap variant="secondary" onClick={() => void mutate("Hand off", { kind: "handoff" })}>
              <HandPlatter className="size-4" /> Hand off
            </Tap>
          )}
          {!closed && live.length > 1 && (
            <Tap variant="outline" onClick={() => setSplitting(new Set())}>
              <Scissors className="size-4" /> Split by item
            </Tap>
          )}
          {!closed && (
            <Tap variant="outline" onClick={discount} data-testid="discount">
              <Percent className="size-4" /> Discount
            </Tap>
          )}
          {net > 0 && (
            <Tap variant="outline" onClick={refund}>
              <Undo2 className="size-4" /> Refund
            </Tap>
          )}
          <Tap variant="outline" onClick={() => onReceipt(order)}>
            <Printer className="size-4" /> Receipt
          </Tap>
          {!closed && (
            <Tap variant="ghost" className="text-destructive" onClick={cancel}>
              <XCircle className="size-4" /> Cancel
            </Tap>
          )}
        </div>
      )}

      {prompt && <PromptDialog spec={prompt} onClose={() => setPrompt(null)} />}
      {paying && (
        <TenderDialog
          open
          title={`Pay #${order.number} · ${orderLabel(order)}`}
          dueCents={due}
          lines={live.map((l) => ({
            lineId: l.lineId,
            label: `${l.quantity} × ${l.name}`,
            cents: l.lineTotalCents - order.adjustments.filter((a) => a.lineId === l.lineId).reduce((s, a) => s + a.cents, 0),
          }))}
          onTender={async (tender) => {
            const o = await mutate("Payment", { kind: "tender", tender });
            return o ? { dueCents: dueCents(o.totals) } : null;
          }}
          onReceipt={() => onReceipt(order)}
          onClose={() => setPaying(false)}
        />
      )}
    </div>
  );
}
