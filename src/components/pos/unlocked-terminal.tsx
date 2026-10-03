"use client";

import { useCallback, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { readOrder } from "@/app/pos/actions";
import type { Actor, Board, OrderView, PosMenu } from "@/lib/orders";
import type { OutboxEntry } from "@/lib/pos-outbox";
import { defaultSelections, needsBuilder } from "@/lib/pos-client/builder";
import { draftLine, findItem, MODES, type Draft, type DraftAction, type DraftLine } from "@/lib/pos-client/draft";
import type { MenuItem, Selection } from "@/lib/pricing";
import { useNow, type ServerSnapshot } from "@/lib/use-server-snapshot";
import { useApprovals } from "./approvals";
import { OrdersBoard, orderLabel } from "./board";
import { CallerPanel } from "./caller-panel";
import { useCheckout } from "./checkout";
import { PosContext, failureText, type Pos, type StoreInfo } from "./context";
import { MenuGrid } from "./menu-grid";
import { notify } from "./notify";
import { OrderDetail } from "./order-detail";
import { OrderPanel } from "./order-panel";
import { NotSentList, OutboxDialog } from "./outbox-ui";
import { PizzaBuilder } from "./pizza-builder";
import { FallbackTicket, Receipt, slipLines } from "./print";
import { CloseShiftDialog, DrawerDialog, OpenShiftDialog } from "./shift-dialogs";
import { TerminalHeader, type TerminalDialog, type TerminalPrefs } from "./terminal-header";

export const POLL_MS = 4_000;

export type Pane =
  | { kind: "menu" }
  | { kind: "caller" }
  | { kind: "builder"; item: MenuItem; initial: { selections: Selection[]; quantity: number; notes: string | null; lineId?: string } }
  | { kind: "board" }
  | { kind: "order"; order: OrderView };

/** The open order on screen, swapped for the board's copy when a fresh board lands. */
export function withFreshOrder(p: Pane, b: Board): Pane {
  if (p.kind !== "order") return p;
  const fresh = b.openOrders.find((o) => o.id === p.order.id);
  return fresh ? { ...p, order: fresh } : p;
}

/** What the terminal keeps while it is locked: the next person picks up the same draft and screen. */
export type KeptState = {
  menu: PosMenu;
  sync: ServerSnapshot<Board>;
  queue: OutboxEntry[];
  draft: Draft;
  dispatch: Dispatch<DraftAction>;
  pane: Pane;
  setPane: Dispatch<SetStateAction<Pane>>;
  prefs: TerminalPrefs;
  updatePrefs: (patch: Partial<TerminalPrefs>) => void;
  print: (node: ReactNode) => void;
};

export function UnlockedTerminal({
  staff,
  lock,
  kept,
  store,
  names,
  askForShift,
  deepLink,
  onDeepLinkOpened,
}: {
  staff: Actor;
  lock: () => void;
  kept: KeptState;
  store: StoreInfo;
  names: Record<number, string>;
  askForShift: boolean;
  deepLink: string | null;
  onDeepLinkOpened: () => void;
}) {
  const { menu, sync, queue, draft, dispatch, pane, setPane, prefs, updatePrefs, print } = kept;
  const { data: board, online, lastSync, refresh: refreshBoard, mutate } = sync;
  const now = useNow(POLL_MS);
  const [dialog, setDialog] = useState<TerminalDialog | null>(askForShift ? { kind: "open_shift" } : null);

  const fail = useCallback(
    (r: { reason: string; message?: string }) => {
      if (r.reason === "locked") lock();
      if (r.reason === "no_open_shift") setDialog({ kind: "open_shift" });
      notify.error(failureText(r));
    },
    [lock],
  );
  const { act, approvalDialog } = useApprovals({ write: mutate, fail });

  const showOrder = useCallback((order: OrderView) => setPane({ kind: "order", order }), [setPane]);

  const openOrder = useCallback(
    async (orderId: string) => {
      const known = board.openOrders.find((o) => o.id === orderId);
      if (known) return showOrder(known);
      const r = await act("Open order", () => readOrder(orderId));
      if (r?.order) showOrder(r.order);
      else if (r) notify.error("That order wasn't found.");
    },
    [board, act, showOrder],
  );

  useEffect(() => {
    if (!deepLink) return;
    onDeepLinkOpened();
    void openOrder(deepLink);
  }, [deepLink, onDeepLinkOpened, openOrder]);

  const receipt = (o: OrderView) => print(<Receipt order={o} store={store} />);

  const { sending, send, pay, checkoutDialog } = useCheckout({
    draft,
    dispatch,
    menu,
    board,
    timeZone: store.timeZone,
    act,
    refreshBoard,
    print,
    receipt,
    lock,
    onNoShift: () => setDialog({ kind: "open_shift" }),
    onAppended: showOrder,
    onDone: () => {
      setPane({ kind: "menu" });
      if (prefs.lockAfterOrder) lock();
    },
  });

  const pickItem = (item: MenuItem) => {
    if (needsBuilder(item)) {
      setPane({ kind: "builder", item, initial: { selections: defaultSelections(item), quantity: 1, notes: null } });
    } else {
      dispatch({ type: "add", lines: [draftLine(item, [], 1, null, menu.policy)] });
    }
  };

  const editLine = (line: DraftLine) => {
    const item = findItem(menu, line.itemId);
    if (!item) return;
    setPane({ kind: "builder", item, initial: { selections: line.selections, quantity: line.quantity, notes: line.notes, lineId: line.lineId } });
  };

  const startAppend = (o: OrderView) => {
    dispatch({ type: "append_to", target: { orderId: o.id, number: o.number, label: orderLabel(o) } });
    setPane({ kind: "menu" });
  };

  const pos: Pos = useMemo(
    () => ({ menu, board, staff, store, online, now, act, refreshBoard, openOrder: (id: string) => void openOrder(id) }),
    [menu, board, staff, store, online, now, act, refreshBoard, openOrder],
  );
  const onBoard = pane.kind === "board" || pane.kind === "order";
  const closeDialog = () => setDialog(null);

  return (
    <PosContext.Provider value={pos}>
      <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        <TerminalHeader
          draftTab={draft.kind === "append" ? `Adding to #${draft.target.number}` : "New order"}
          onBoard={onBoard}
          onDraftTab={() => setPane(draft.kind === "new" && MODES[draft.mode].phoneFirst && draft.lines.length === 0 ? { kind: "caller" } : { kind: "menu" })}
          onBoardTab={() => setPane({ kind: "board" })}
          queue={queue}
          lastSync={lastSync}
          prefs={prefs}
          updatePrefs={updatePrefs}
          openDialog={setDialog}
          lock={lock}
        />

        <div className="flex min-h-0 flex-1">
          <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3">
            {queue.length > 0 && onBoard && <NotSentList queue={queue} onOpen={() => setDialog({ kind: "outbox" })} />}
            {pane.kind === "menu" && <MenuGrid menu={menu} onPick={pickItem} />}
            {pane.kind === "caller" && draft.kind === "new" && <CallerPanel draft={draft} dispatch={dispatch} onContinue={() => setPane({ kind: "menu" })} />}
            {pane.kind === "builder" && (
              <PizzaBuilder
                key={pane.initial.lineId ?? pane.item.id}
                item={pane.item}
                policy={menu.policy}
                initial={pane.initial}
                onCancel={() => setPane({ kind: "menu" })}
                onDone={(line) => {
                  dispatch(pane.initial.lineId ? { type: "replace", line } : { type: "add", lines: [line] });
                  setPane({ kind: "menu" });
                }}
              />
            )}
            {pane.kind === "board" && <OrdersBoard />}
            {pane.kind === "order" && (
              <OrderDetail
                key={pane.order.id}
                order={pane.order}
                onChange={(o) => {
                  showOrder(o);
                  void refreshBoard();
                }}
                onBack={() => setPane({ kind: "board" })}
                onAddItems={startAppend}
                onReceipt={receipt}
              />
            )}
          </main>
          <OrderPanel draft={draft} dispatch={dispatch} busy={sending} onEditLine={editLine} onShowCaller={() => setPane({ kind: "caller" })} onSend={send} onPay={pay} />
        </div>
      </div>

      {checkoutDialog}
      {approvalDialog}
      {dialog?.kind === "open_shift" && <OpenShiftDialog onClose={closeDialog} />}
      {dialog?.kind === "close_shift" && <CloseShiftDialog shiftId={dialog.shiftId} names={names} onClose={closeDialog} />}
      {dialog?.kind === "drawer" && <DrawerDialog kind={dialog.drawer} onClose={closeDialog} />}
      {dialog?.kind === "outbox" && (
        <OutboxDialog
          queue={queue}
          online={online}
          lastSync={lastSync}
          timeZone={store.timeZone}
          onPrint={(e) => print(<FallbackTicket req={e.request} lines={slipLines(e.request, menu)} at={e.createdAt} timeZone={store.timeZone} />)}
          onClose={closeDialog}
        />
      )}
    </PosContext.Provider>
  );
}
