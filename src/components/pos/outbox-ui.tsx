"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardList, Printer, RotateCw, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCents } from "@/lib/money";
import * as outbox from "@/lib/pos-outbox";
import { formatStoreTime } from "@/lib/store-time";
import { cn } from "@/lib/utils";
import { notify } from "./notify";
import { shortId } from "./print";

/** The outbox as React state, and a drain that announces what got through. */
export function useOutboxQueue(): { queue: outbox.OutboxEntry[]; drain: () => Promise<void> } {
  const [queue, setQueue] = useState<outbox.OutboxEntry[]>([]);

  useEffect(() => {
    const sync = () => void outbox.entries().then(setQueue);
    sync();
    return outbox.subscribe(sync);
  }, []);

  const drain = useCallback(async () => {
    const sent = await outbox.drain();
    for (const o of sent) notify.success(`#${o.number} sent: the order that was waiting offline reached the kitchen`);
  }, []);

  return { queue, drain };
}

async function retryEntry(e: outbox.OutboxEntry) {
  const out = await outbox.retry(e.orderId);
  if (out?.kind === "sent") notify.success(`#${out.order.number} sent`);
  else if (out) notify.error(out.kind === "rejected" ? out.message : "Still can't reach the server.");
}

export function NotSentList({ queue, onOpen }: { queue: outbox.OutboxEntry[]; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="rounded-2xl border-2 border-destructive bg-destructive/5 p-3 text-left" data-testid="not-sent">
      <p className="font-bold text-destructive">NOT SENT · the kitchen screen has not received these</p>
      <ul className="text-sm">
        {queue.map((e) => (
          <li key={e.orderId}>
            ID {shortId(e.orderId)} · {e.request.customer?.name ?? "Walk-in"} · {e.request.lines.length} line{e.request.lines.length === 1 ? "" : "s"}
            {e.state === "rejected" && <b className="text-destructive"> · refused: {e.lastError}</b>}
          </li>
        ))}
      </ul>
    </button>
  );
}

export function OutboxDialog({
  queue,
  online,
  lastSync,
  timeZone,
  onPrint,
  onClose,
}: {
  queue: outbox.OutboxEntry[];
  online: boolean;
  lastSync: number;
  timeZone: string;
  onPrint: (e: outbox.OutboxEntry) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(640px,calc(100vw-2rem))] gap-4 sm:max-w-none!" data-testid="outbox-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <ClipboardList className="size-5" /> Connection and unsent orders
          </DialogTitle>
          <DialogDescription>
            {online ? "Connected" : "Not connected"}. Last sync {formatStoreTime(new Date(lastSync), timeZone)}. Orders that fail to send are kept on this
            device and retried automatically. While the internet is down the kitchen screen is down too, so hand the printed paper ticket to the
            kitchen. Payments, voids and approvals on existing orders need the connection.
          </DialogDescription>
        </DialogHeader>
        {queue.length === 0 ? (
          <p className="text-muted-foreground">Nothing waiting. Every order has reached the server.</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {queue.map((e) => (
              <li key={e.orderId} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className={cn("font-semibold", "text-destructive")}>
                    {e.state === "pending" ? "NOT SENT" : "REFUSED"} · ID {shortId(e.orderId)}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    {e.request.customer?.name ?? "Walk-in"} · {e.request.lines.length} line(s) · {e.request.tenders.length > 0 ? `paid ${formatCents(e.request.tenders.reduce((s, t) => s + t.amountCents, 0))}` : "unpaid"} · {e.attempts} tr
                    {e.attempts === 1 ? "y" : "ies"}
                    {e.lastError ? ` · ${e.lastError}` : ""}
                  </p>
                </div>
                <button type="button" className="flex size-11 items-center justify-center rounded-lg hover:bg-muted" onClick={() => onPrint(e)} aria-label="Print paper ticket">
                  <Printer className="size-5" />
                </button>
                <button type="button" className="flex size-11 items-center justify-center rounded-lg hover:bg-muted" onClick={() => void retryEntry(e)} aria-label="Retry now">
                  <RotateCw className="size-5" />
                </button>
                {e.state === "rejected" && (
                  <button type="button" className="flex size-11 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10" onClick={() => void outbox.discard(e.orderId)} aria-label="Discard">
                    <Trash2 className="size-5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

