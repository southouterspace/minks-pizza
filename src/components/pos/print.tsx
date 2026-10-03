"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  channelLabel,
  dueCents,
  type OrderView,
  type PosMenu,
  type SubmitOrderRequest,
} from "@/lib/orders";
import { findItem, lineSummary } from "@/lib/pos-client/draft";
import { formatCents } from "@/lib/money";
import { priceLine } from "@/lib/pricing";
import { formatStoreDateTime, formatStoreTime } from "@/lib/store-time";
import type { StoreInfo } from "./context";
import { chargeRows } from "./totals";

export function usePrinter() {
  const [job, setJob] = useState<{ node: ReactNode; n: number } | null>(null);

  useEffect(() => {
    if (!job) return;
    const t = setTimeout(() => window.print(), 50);
    return () => clearTimeout(t);
  }, [job]);

  const print = useCallback((node: ReactNode) => setJob((j) => ({ node, n: (j?.n ?? 0) + 1 })), []);
  const portal = job ? createPortal(<div id="pos-print">{job.node}</div>, document.body) : null;
  return { print, portal };
}

const Rule = () => <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />;

function Row({ left, right, bold }: { left: ReactNode; right: ReactNode; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontWeight: bold ? 700 : 400 }}>
      <span>{left}</span>
      <span style={{ whiteSpace: "nowrap" }}>{right}</span>
    </div>
  );
}

function Fulfillment({ order }: { order: Pick<OrderView, "fulfillment" | "customer" | "notes"> }) {
  const f = order.fulfillment;
  return (
    <>
      {f.kind === "dine_in" && <div style={{ fontWeight: 700 }}>DINE-IN · TABLE {f.table}</div>}
      {f.kind === "pickup" && <div style={{ fontWeight: 700 }}>PICKUP</div>}
      {f.kind === "delivery" && (
        <>
          <div style={{ fontWeight: 700 }}>DELIVERY</div>
          <div>{f.address.line1}</div>
          {f.address.line2 && <div>{f.address.line2}</div>}
          <div>{[f.address.city, f.address.zip].filter(Boolean).join(" ")}</div>
        </>
      )}
      {(order.customer.name || order.customer.phone) && (
        <div>
          {order.customer.name}
          {order.customer.phone ? ` · ${order.customer.phone}` : ""}
        </div>
      )}
      {order.notes && <div style={{ fontWeight: 700 }}>NOTE: {order.notes}</div>}
    </>
  );
}

export function Receipt({ order, store }: { order: OrderView; store: StoreInfo }) {
  const t = order.totals;
  const live = order.lines.filter((l) => !l.voided);
  const due = dueCents(t);
  return (
    <div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: "14pt", fontWeight: 700 }}>{store.name}</div>
        {store.address && <div>{store.address}</div>}
        {store.phone && <div>{store.phone}</div>}
      </div>
      <Rule />
      <Row left={<b>Order #{order.number}</b>} right={channelLabel(order.channel, order.fulfillment.kind)} />
      <div>{formatStoreDateTime(order.placedAt, store.timeZone)}</div>
      <Fulfillment order={order} />
      <Rule />
      {live.map((l) => (
        <div key={l.lineId} style={{ marginBottom: 4 }}>
          <Row left={`${l.quantity} × ${l.name}`} right={formatCents(l.lineTotalCents)} />
          {l.modifiers.length > 0 && <div style={{ paddingLeft: 12 }}>{lineSummary(l.modifiers)}</div>}
          {l.notes && <div style={{ paddingLeft: 12 }}>“{l.notes}”</div>}
        </div>
      ))}
      <Rule />
      {chargeRows(t).map((r) => (
        <Row key={r.label} left={r.label} right={r.amount} />
      ))}
      <Row left="TOTAL" right={formatCents(t.totalCents)} bold />
      <Rule />
      {order.tenders.map((tn) => (
        <div key={tn.id}>
          <Row
            left={`${tn.direction === "refund" ? "Refund " : ""}${tn.method === "cash" ? "Cash" : `Card${tn.last4 ? ` ••${tn.last4}` : ""}`}`}
            right={`${tn.direction === "refund" ? "−" : ""}${formatCents(tn.amountCents)}`}
          />
          {tn.method === "cash" && tn.tenderedCents !== null && tn.tenderedCents > tn.amountCents && (
            <>
              <Row left="  Tendered" right={formatCents(tn.tenderedCents)} />
              <Row left="  Change" right={formatCents(tn.tenderedCents - tn.amountCents)} />
            </>
          )}
          {tn.tipCents > 0 && <Row left="  Tip" right={formatCents(tn.tipCents)} />}
        </div>
      ))}
      <Row left={due > 0 ? "BALANCE DUE" : "PAID"} right={formatCents(due)} bold />
      <Rule />
      <div style={{ textAlign: "center" }}>Thank you!</div>
    </div>
  );
}

/** What a queued order goes by until the server numbers it: the last six of its client id. */
export const shortId = (orderId: string) => orderId.slice(-6).toUpperCase();

export type SlipLine = { name: string; quantity: number; summary: string; notes: string | null };

/** Rebuilds printable lines from a queued request, which carries only ids. */
export function slipLines(req: SubmitOrderRequest, menu: PosMenu): SlipLine[] {
  return req.lines.map((l) => {
    const item = findItem(menu, l.itemId);
    if (!item) return { name: `Item #${l.itemId}`, quantity: l.quantity, summary: "", notes: l.notes };
    try {
      return { name: item.name, quantity: l.quantity, summary: lineSummary(priceLine(item, l.selections, menu.policy).modifiers), notes: l.notes };
    } catch {
      return { name: item.name, quantity: l.quantity, summary: "(options changed)", notes: l.notes };
    }
  });
}

/**
 * The paper ticket printed when an order could not reach the server. It has
 * no order number (the server assigns those), so it carries the last six
 * characters of the client id, which the screen shows next to the order.
 */
export function FallbackTicket({ req, lines, at, timeZone }: { req: SubmitOrderRequest; lines: SlipLine[]; at: number; timeZone: string }) {
  const f = req.fulfillment;
  return (
    <div>
      <div style={{ fontSize: "16pt", fontWeight: 800, textAlign: "center" }}>NOT SENT · PAPER TICKET</div>
      <div style={{ textAlign: "center" }}>Kitchen screen did not get this order</div>
      <Rule />
      <Row left={<b>ID {shortId(req.orderId)}</b>} right={formatStoreTime(new Date(at), timeZone)} />
      <Fulfillment
        order={{
          fulfillment: f,
          customer: { id: null, name: req.customer?.name ?? "", phone: req.customer?.phone ?? "", email: null },
          notes: req.notes,
        }}
      />
      {req.fire.kind === "at" && <div style={{ fontWeight: 700 }}>START AT {formatStoreTime(req.fire.at, timeZone)}</div>}
      {req.fire.kind === "hold" && <div style={{ fontWeight: 700 }}>HOLD · DO NOT START</div>}
      <Rule />
      {lines.map((l, i) => (
        <div key={i} style={{ marginBottom: 6 }}>
          <div style={{ fontSize: "13pt", fontWeight: 700 }}>
            {l.quantity} × {l.name}
          </div>
          {l.summary && <div style={{ paddingLeft: 12 }}>{l.summary}</div>}
          {l.notes && <div style={{ paddingLeft: 12, fontWeight: 700 }}>“{l.notes}”</div>}
        </div>
      ))}
      <Rule />
      <div>{req.tenders.length > 0 ? "PAID AT COUNTER" : "NOT PAID"}</div>
    </div>
  );
}
