"use client";

import { useState, type Dispatch, type ReactNode } from "react";
import { mutateOrderAction } from "@/app/pos/actions";
import { dueCents, type Board, type OrderView, type PosMenu, type TenderInput } from "@/lib/orders";
import * as outbox from "@/lib/pos-outbox";
import { draftTotals, MODES, toSubmitLine, toSubmitRequest, type AppendDraft, type Draft, type DraftAction, type NewOrderDraft } from "@/lib/pos-client/draft";
import { failureText, type Pos } from "./context";
import { notify } from "./notify";
import { FallbackTicket, slipLines } from "./print";
import { TenderDialog, type TenderOutcome } from "./tender-dialog";

/** Paying for the draft as it was when Pay was tapped; `placed` once the first tender sent it. */
type Checkout = {
  title: string;
  draft: NewOrderDraft;
  dueCents: number;
  /** `order` is null while the order waits in the outbox. */
  placed: { orderId: string; order: OrderView | null } | null;
};

/**
 * Sending the draft: a new order through the outbox, lines added to an open
 * check through a mutation, and paying a new order at the counter.
 */
export function useCheckout({
  draft,
  dispatch,
  menu,
  board,
  timeZone,
  act,
  refreshBoard,
  print,
  receipt,
  lock,
  onNoShift,
  onAppended,
  onDone,
}: {
  draft: Draft;
  dispatch: Dispatch<DraftAction>;
  menu: PosMenu;
  board: Board;
  timeZone: string;
  act: Pos["act"];
  refreshBoard: () => Promise<void>;
  print: (node: ReactNode) => void;
  receipt: (o: OrderView) => void;
  lock: () => void;
  onNoShift: () => void;
  onAppended: (o: OrderView) => void;
  onDone: () => void;
}): { sending: boolean; send: () => void; pay: () => void; checkoutDialog: ReactNode } {
  const [sending, setSending] = useState(false);
  const [checkout, setCheckout] = useState<Checkout | null>(null);

  const quoteFor = (d: NewOrderDraft) => (MODES[d.mode].fulfillment === "delivery" ? board.quote.deliveryMinutes : board.quote.pickupMinutes);

  /** Hands the draft to the outbox and starts the next order once the outbox holds it. */
  const submitDraft = async (d: NewOrderDraft, tenders: TenderInput[]): Promise<{ ok: boolean; order: OrderView | null }> => {
    const req = toSubmitRequest(d, quoteFor(d), tenders);
    setSending(true);
    const out = await outbox.submit(req);
    setSending(false);
    if (out.kind !== "rejected") dispatch({ type: "next" });
    switch (out.kind) {
      case "sent":
        notify.success(`#${out.order.number} sent${out.order.status === "held" ? " (held)" : ""}`);
        void refreshBoard();
        return { ok: true, order: out.order };
      case "queued":
        notify.error("NOT SENT: printing a paper ticket. It will send when the connection is back.", { duration: 10_000 });
        print(<FallbackTicket req={req} lines={slipLines(req, menu)} at={Date.now()} timeZone={timeZone} />);
        void refreshBoard();
        return { ok: true, order: null };
      case "locked":
        notify.error("The terminal locked. The order is saved and sends after you unlock.");
        lock();
        return { ok: true, order: null };
      case "rejected":
        await outbox.discard(req.orderId);
        notify.error(out.message);
        return { ok: false, order: null };
    }
  };

  const appendLines = async ({ target, lines }: AppendDraft) => {
    setSending(true);
    const r = await act("Add to check", (approval) =>
      mutateOrderAction({ orderId: target.orderId, mutation: { kind: "add_lines", lines: lines.map(toSubmitLine), fire: true }, approval }),
    );
    setSending(false);
    if (r && "order" in r) {
      notify.success(`Added to #${target.number}`);
      dispatch({ type: "next" });
      onAppended(r.order);
      void refreshBoard();
    }
  };

  const send = async () => {
    if (draft.kind === "append") return appendLines(draft);
    if ((await submitDraft(draft, [])).ok) onDone();
  };

  const pay = () => {
    if (draft.kind !== "new") return;
    if (!board.shift) {
      notify.error(failureText({ reason: "no_open_shift" }));
      onNoShift();
      return;
    }
    setCheckout({ title: `Pay new ${MODES[draft.mode].noun} order`, draft, dueCents: draftTotals(draft, menu).totalCents, placed: null });
  };

  /**
   * The first tender submits the order with it through the outbox, so money
   * taken is on the order (or queued in IndexedDB) before the next guest
   * pays. Later tenders are payments against that order.
   */
  const takeTender = async (c: Checkout, tender: TenderInput): Promise<TenderOutcome> => {
    if (!c.placed) {
      const { ok, order } = await submitDraft(c.draft, [tender]);
      if (!ok) return null;
      setCheckout({ ...c, placed: { orderId: c.draft.orderId, order } });
      return { dueCents: order ? dueCents(order.totals) : c.dueCents - tender.amountCents };
    }
    const { orderId } = c.placed;
    if (!c.placed.order) {
      await outbox.drain();
      if ((await outbox.entries()).some((e) => e.orderId === orderId)) {
        notify.error("This order hasn't reached the server yet. Take the rest once the connection is back.");
        return null;
      }
    }
    const r = await act("Payment", (approval) => mutateOrderAction({ orderId, mutation: { kind: "tender", tender }, approval }));
    if (!r || !("order" in r)) return null;
    setCheckout({ ...c, placed: { orderId, order: r.order } });
    return { dueCents: dueCents(r.order.totals) };
  };

  const payLater = async (c: Checkout) => {
    if (!c.placed && !(await submitDraft(c.draft, [])).ok) return;
    setCheckout(null);
    onDone();
  };

  const close = (c: Checkout) => {
    setCheckout(null);
    if (c.placed) onDone();
  };

  const checkoutDialog = checkout && (
    <TenderDialog
      key={checkout.draft.orderId}
      open
      title={checkout.title}
      dueCents={checkout.dueCents}
      lines={checkout.draft.lines.map((l) => ({ lineId: l.lineId, label: `${l.quantity} × ${l.name}`, cents: l.unitPriceCents * l.quantity }))}
      onTender={(t) => takeTender(checkout, t)}
      onPayLater={() => void payLater(checkout)}
      onReceipt={() => checkout.placed?.order && receipt(checkout.placed.order)}
      onClose={() => close(checkout)}
    />
  );

  return { sending, send: () => void send(), pay, checkoutDialog };
}
