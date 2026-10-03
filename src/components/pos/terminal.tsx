"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { notify } from "./notify";
import { ClipboardList, Lock, Menu as MenuIcon, Moon, Printer, RotateCw, Trash2, WifiOff } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { keepUnlocked, lockTerminal, mutateOrderAction, readOrder, switchEmployee } from "@/app/pos/actions";
import { type Actor, type Approval, type DrawerEventKind, type OrderView, type TenderInput } from "@/lib/orders";
import type { Board, PosMenu } from "@/lib/orders-server";
import * as outbox from "@/lib/pos-outbox";
import { defaultSelections, needsBuilder } from "@/lib/pos-client/builder";
import { draftLine, draftReducer, draftTotals, emptyDraft, findItem, isPhoneFirst, toSubmitRequest, type Draft, type DraftLine, type Mode } from "@/lib/pos-client/draft";
import { formatCents } from "@/lib/money";
import type { MenuItem, Selection } from "@/lib/pricing";
import { formatStoreTime } from "@/lib/store-time";
import { cn } from "@/lib/utils";
import { OrdersBoard, orderLabel } from "./board";
import { CallerPanel } from "./caller-panel";
import { PosContext, failureText, type ActionResult, type Pos, type StoreInfo } from "./context";
import { MenuGrid } from "./menu-grid";
import { OrderDetail } from "./order-detail";
import { OrderPanel } from "./order-panel";
import { LockScreen, ManagerPinDialog } from "./pin-pad";
import { PizzaBuilder } from "./pizza-builder";
import { FallbackTicket, Receipt, slipLines, usePrinter } from "./print";
import { CloseShiftDialog, DrawerDialog, OpenShiftDialog } from "./shift-dialogs";
import { TenderDialog } from "./tender-dialog";
import { Tap } from "./touch";

const POLL_MS = 4_000;
const MENU_POLL_MS = 60_000;
const RENEW_MS = 20_000;
const PREFS_KEY = "minks:pos-prefs";

type Prefs = { dark: boolean; lockAfterOrder: boolean };

function loadPrefs(): Prefs {
  try {
    return { dark: false, lockAfterOrder: false, ...JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return { dark: false, lockAfterOrder: false };
  }
}

type Pane =
  | { kind: "menu" }
  | { kind: "caller" }
  | { kind: "builder"; item: MenuItem; initial: { selections: Selection[]; quantity: number; notes: string | null; lineId?: string } }
  | { kind: "board" }
  | { kind: "order"; order: OrderView };

type PendingApproval = {
  label: string;
  call: (approval?: Approval) => Promise<ActionResult>;
  resolve: (r: ActionResult | null) => void;
  error: string | null;
  busy: boolean;
};

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s ago` : `${Math.round(ms / 60_000)}m ago`);

export function PosTerminal({
  initialMenu,
  initialBoard,
  initialStaff,
  store,
  lockSeconds,
  names,
  deepLinkOrderId,
}: {
  initialMenu: PosMenu;
  initialBoard: Board;
  initialStaff: Actor | null;
  store: StoreInfo;
  lockSeconds: number;
  names: Record<number, string>;
  deepLinkOrderId: string | null;
}) {
  const [staff, setStaff] = useState<Actor | null>(initialStaff);
  const [lastName, setLastName] = useState<string | null>(initialStaff?.name ?? null);
  const [menu, setMenu] = useState(initialMenu);
  const [board, setBoard] = useState<Board | null>(initialBoard);
  const [online, setOnline] = useState(true);
  const [lastSync, setLastSync] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [queue, setQueue] = useState<outbox.OutboxEntry[]>([]);
  const [draft, dispatch] = useReducer(draftReducer, undefined, () => emptyDraft());
  const [pane, setPane] = useState<Pane>({ kind: "menu" });
  const [sending, setSending] = useState(false);
  const [paying, setPaying] = useState<{
    key: string;
    tenders: TenderInput[];
    /** Set once the paid order went to the outbox; `order` is null when it was queued, not sent. */
    submitted: { order: OrderView | null } | null;
  } | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [dialog, setDialog] = useState<null | { kind: "open_shift" } | { kind: "close_shift"; shiftId: string } | { kind: "drawer"; drawer: DrawerEventKind } | { kind: "outbox" }>(null);
  const [prefs, setPrefs] = useState<Prefs>({ dark: false, lockAfterOrder: false });
  const { print, portal } = usePrinter();
  const router = useRouter();
  const lastActivity = useRef(0);
  const lastRenew = useRef(0);
  const deepLink = useRef(deepLinkOrderId);


  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after hydration
    setPrefs(loadPrefs());
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", prefs.dark);
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Storage blocked: preferences just won't persist.
    }
  }, [prefs]);


  const lock = useCallback(() => {
    setStaff(null);
    setPaying(null);
    setApproval((a) => {
      a?.resolve(null);
      return null;
    });
    lockTerminal().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!staff) return;
    lastActivity.current = Date.now();
    const onActivity = () => {
      lastActivity.current = Date.now();
      if (Date.now() - lastRenew.current < RENEW_MS) return;
      lastRenew.current = Date.now();
      keepUnlocked()
        .then((r) => !r.ok && lock())
        .catch(() => undefined);
    };
    const tick = setInterval(() => {
      if (Date.now() - lastActivity.current > lockSeconds * 1000) lock();
    }, 1000);
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    return () => {
      clearInterval(tick);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [staff, lockSeconds, lock]);


  const drain = useCallback(async () => {
    const sent = await outbox.drain();
    for (const o of sent) notify.success(`#${o.number} sent: the order that was waiting offline reached the kitchen`);
  }, []);

  useEffect(() => {
    const sync = () => void outbox.entries().then(setQueue);
    sync();
    return outbox.subscribe(sync);
  }, []);


  const refreshBoard = useCallback(async () => {
    try {
      const res = await fetch("/api/pos/board", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/admin/login");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const b = (await res.json()) as Board;
      setBoard(b);
      setOnline(true);
      setLastSync(Date.now());
      setPane((p) => {
        if (p.kind !== "order") return p;
        const fresh = b.openOrders.find((o) => o.id === p.order.id);
        return fresh ? { ...p, order: fresh } : p;
      });
      void drain();
    } catch {
      setOnline(false);
    }
  }, [drain, router]);

  useEffect(() => {
    const t = setInterval(() => {
      void refreshBoard();
      setNow(Date.now());
    }, POLL_MS);
    const onOnline = () => void refreshBoard();
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      clearInterval(t);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [refreshBoard]);

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await fetch("/api/pos/menu", { cache: "no-store" });
        if (!res.ok) return;
        const m = (await res.json()) as PosMenu;
        setMenu((cur) => (cur.version === m.version ? cur : m));
      } catch {
        // Keep the cached menu; entry never waits on the network.
      }
    }, MENU_POLL_MS);
    return () => clearInterval(t);
  }, []);


  const fail = useCallback(
    (r: { reason: string; message?: string }) => {
      if (r.reason === "locked") lock();
      if (r.reason === "no_open_shift") setDialog({ kind: "open_shift" });
      notify.error(failureText(r));
    },
    [lock],
  );

  const act = useCallback(
    async <T extends ActionResult>(label: string, call: (approval?: Approval) => Promise<T>) => {
      let r: T;
      try {
        r = await call();
      } catch {
        fail({ reason: "offline" });
        return null;
      }
      if (r.ok) return r as Extract<T, { ok: true }>;
      if (r.reason !== "needs_manager") {
        fail(r);
        return null;
      }
      const approved = await new Promise<ActionResult | null>((resolve) =>
        setApproval({ label, call: call as PendingApproval["call"], resolve, error: null, busy: false }),
      );
      return approved as Extract<T, { ok: true }> | null;
    },
    [fail],
  );

  const onManagerPin = async (pin: string) => {
    const a = approval;
    if (!a) return;
    setApproval({ ...a, busy: true, error: null });
    let r: ActionResult;
    try {
      r = await a.call({ managerPin: pin });
    } catch {
      setApproval({ ...a, busy: false, error: failureText({ reason: "offline" }) });
      return;
    }
    if (r.ok) {
      setApproval(null);
      a.resolve(r);
      return;
    }
    const retryable: Record<string, string> = {
      bad_pin: "Wrong PIN. Try again.",
      needs_manager: "That PIN isn't a manager's.",
      locked_out: failureText({ reason: "locked_out" }),
    };
    if (r.reason in retryable) {
      setApproval({ ...a, busy: false, error: retryable[r.reason] });
      return;
    }
    setApproval(null);
    a.resolve(null);
    fail(r);
  };


  const showOrder = useCallback((order: OrderView) => setPane({ kind: "order", order }), []);

  const openOrder = useCallback(
    async (orderId: string) => {
      const known = board?.openOrders.find((o) => o.id === orderId);
      if (known) return showOrder(known);
      const r = await act("Open order", () => readOrder(orderId));
      if (r?.order) showOrder(r.order);
      else if (r) notify.error("That order wasn't found.");
    },
    [board, act, showOrder],
  );

  useEffect(() => {
    if (!staff || !deepLink.current) return;
    const id = deepLink.current;
    deepLink.current = null;
    void openOrder(id);
  }, [staff, openOrder]);

  const quoteFor = (mode: Mode) => (mode === "delivery" ? board?.quote.deliveryMinutes : board?.quote.pickupMinutes) ?? 20;

  const finishDraft = useCallback(
    (mode: Mode) => {
      dispatch({ type: "reset", mode: mode === "dine_in" ? "dine_in" : "walk_in" });
      setPane({ kind: "menu" });
      if (prefs.lockAfterOrder) lock();
    },
    [prefs.lockAfterOrder, lock],
  );

  const submitDraft = async (d: Draft, tenders: TenderInput[]): Promise<{ ok: boolean; order: OrderView | null }> => {
    const req = toSubmitRequest(d, quoteFor(d.mode), tenders);
    setSending(true);
    const out = await outbox.submit(req);
    setSending(false);
    switch (out.kind) {
      case "sent":
        notify.success(`#${out.order.number} sent${out.order.status === "held" ? " (held)" : ""}`);
        void refreshBoard();
        return { ok: true, order: out.order };
      case "queued":
        notify.error("NOT SENT: printing a paper ticket. It will send when the connection is back.", { duration: 10_000 });
        print(<FallbackTicket req={req} lines={slipLines(req, menu)} at={Date.now()} timeZone={store.timeZone} />);
        setOnline(false);
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

  const send = async () => {
    if (draft.appendTo) {
      const target = draft.appendTo;
      const lines = draft.lines.map(({ lineId, itemId, quantity, selections, notes }) => ({ lineId, itemId, quantity, selections, notes }));
      setSending(true);
      const r = await act("Add to check", (approval) =>
        mutateOrderAction({ orderId: target.orderId, mutation: { kind: "add_lines", lines, fire: true }, approval }),
      );
      setSending(false);
      if (r && "order" in r) {
        notify.success(`Added to #${target.number}`);
        dispatch({ type: "reset", mode: "walk_in" });
        showOrder(r.order);
        void refreshBoard();
      }
      return;
    }
    const mode = draft.mode;
    const { ok } = await submitDraft(draft, []);
    if (ok) finishDraft(mode);
  };

  const pay = () => {
    if (!board?.shift) {
      notify.error(failureText({ reason: "no_open_shift" }));
      setDialog({ kind: "open_shift" });
      return;
    }
    setPaying({ key: draft.orderId, tenders: [], submitted: null });
  };

  const draftTotal = draftTotals(draft, menu).totalCents;

  const closePaying = async () => {
    const p = paying;
    setPaying(null);
    if (!p) return;
    if (p.submitted) return finishDraft(draft.mode);
    if (p.tenders.length > 0) {
      // Money was taken: the order must be recorded with it.
      const { ok } = await submitDraft(draft, p.tenders);
      if (ok) finishDraft(draft.mode);
    }
  };


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
    dispatch({
      type: "append_to",
      order: { orderId: o.id, number: o.number, label: orderLabel(o) },
      mode: o.fulfillment.kind === "dine_in" ? "dine_in" : o.fulfillment.kind === "delivery" ? "delivery" : "walk_in",
    });
    setPane({ kind: "menu" });
  };

  const receipt = (o: OrderView) => print(<Receipt order={o} store={store} />);


  const pending = queue.filter((e) => e.state === "pending").length;
  const rejected = queue.length - pending;
  const openCount = board?.openOrders.length ?? 0;

  const pos: Pos | null = useMemo(
    () => (staff ? { menu, board, staff, store, online, now, act, refreshBoard, openOrder: (id: string) => void openOrder(id) } : null),
    [menu, board, staff, store, online, now, act, refreshBoard, openOrder],
  );

  const unlock = async (pin: string): Promise<string | null> => {
    try {
      const r = await switchEmployee(pin);
      if (!r.ok) {
        if (r.reason === "signed_out") router.replace("/admin/login");
        return failureText(r);
      }
      setStaff(r.actor);
      setLastName(r.actor.name);
      lastRenew.current = Date.now();
      void drain();
      if (!board?.shift) setDialog({ kind: "open_shift" });
      return null;
    } catch {
      return failureText({ reason: "offline" });
    }
  };

  if (!pos) {
    return (
      <>
        <LockScreen storeName={store.name} timeZone={store.timeZone} lastName={lastName} onPin={unlock} />
        {portal}
      </>
    );
  }

  const tab = (active: boolean) =>
    cn("h-11 rounded-lg px-4 text-base font-medium", active ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground");
  const onBoard = pane.kind === "board" || pane.kind === "order";

  return (
    <PosContext.Provider value={pos}>
      <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b px-3">
          <span className="hidden text-base font-semibold lg:block">{store.name}</span>
          <nav className="flex gap-1 rounded-xl bg-muted p-1">
            <button type="button" className={tab(!onBoard)} onClick={() => setPane(isPhoneFirst(draft.mode) && draft.lines.length === 0 ? { kind: "caller" } : { kind: "menu" })}>
              {draft.appendTo ? `Adding to #${draft.appendTo.number}` : "New order"}
            </button>
            <button type="button" className={tab(onBoard)} onClick={() => setPane({ kind: "board" })} data-testid="tab-board">
              Open orders <span className="ml-1 rounded-md bg-foreground/10 px-1.5 tabular-nums">{openCount}</span>
            </button>
          </nav>

          <button
            type="button"
            onClick={() => setDialog({ kind: "outbox" })}
            data-testid="health"
            className={cn(
              "ml-auto flex h-11 items-center gap-2 rounded-xl px-3 text-sm",
              queue.length > 0 ? "bg-destructive text-white" : online ? "text-muted-foreground hover:bg-muted" : "bg-destructive/10 text-destructive",
            )}
          >
            {online ? <span className="size-2.5 rounded-full bg-success" /> : <WifiOff className="size-4" />}
            <span>
              {online ? "Online" : "Offline"} · synced {ago(now - lastSync)}
            </span>
            {queue.length > 0 && (
              <b data-testid="not-sent-count">
                · {pending > 0 && `${pending} NOT SENT`}
                {rejected > 0 && `${pending > 0 ? ", " : ""}${rejected} refused`}
              </b>
            )}
          </button>

          {!board?.shift && (
            <Tap variant="outline" className="border-warning text-warning" onClick={() => setDialog({ kind: "open_shift" })}>
              Open shift
            </Tap>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger className="flex h-11 items-center gap-2 rounded-xl px-3 hover:bg-muted" data-testid="staff-menu">
              <span className="text-right leading-tight">
                <span className="block font-semibold">{staff!.name}</span>
                <span className="block text-xs text-muted-foreground capitalize">{staff!.role}</span>
              </span>
              <MenuIcon className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuGroup>
              <DropdownMenuLabel>{board?.shift ? `Shift open since ${formatStoreTime(board.shift.openedAt, store.timeZone)}` : "No open shift"}</DropdownMenuLabel>
              {board?.shift ? (
                <>
                  <DropdownMenuItem onClick={() => setDialog({ kind: "drawer", drawer: "no_sale" })}>Open drawer (no sale)</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setDialog({ kind: "drawer", drawer: "paid_in" })}>Paid in</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setDialog({ kind: "drawer", drawer: "paid_out" })}>Paid out</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setDialog({ kind: "close_shift", shiftId: board.shift!.id })} data-testid="menu-close-shift">
                    Close shift…
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem onClick={() => setDialog({ kind: "open_shift" })}>Open shift…</DropdownMenuItem>
              )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={prefs.lockAfterOrder} onCheckedChange={(v) => setPrefs({ ...prefs, lockAfterOrder: v })}>
                Lock after each order
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={prefs.dark} onCheckedChange={(v) => setPrefs({ ...prefs, dark: v })}>
                <Moon className="size-4" /> Dark screen
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tap variant="secondary" onClick={lock} aria-label="Lock terminal" data-testid="lock">
            <Lock className="size-5" />
          </Tap>
        </header>

        <div className="flex min-h-0 flex-1">
          <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3">
            {queue.length > 0 && onBoard && <NotSentList queue={queue} onOpen={() => setDialog({ kind: "outbox" })} />}
            {pane.kind === "menu" && <MenuGrid menu={menu} onPick={pickItem} />}
            {pane.kind === "caller" && <CallerPanel draft={draft} dispatch={dispatch} onContinue={() => setPane({ kind: "menu" })} />}
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
          <OrderPanel
            draft={draft}
            dispatch={dispatch}
            busy={sending}
            onEditLine={editLine}
            onShowCaller={() => setPane({ kind: "caller" })}
            onSend={() => void send()}
            onPay={pay}
          />
        </div>
      </div>

      {paying && (
        <TenderDialog
          key={paying.key}
          open
          title={`Pay new ${isPhoneFirst(draft.mode) ? "phone" : draft.mode === "dine_in" ? "dine-in" : "walk-in"} order`}
          dueCents={draftTotal}
          lines={draft.lines.map((l) => ({ lineId: l.lineId, label: `${l.quantity} × ${l.name}`, cents: l.unitPriceCents * l.quantity }))}
          onTender={async (t) => {
            const tenders = [...paying.tenders, t];
            const remaining = draftTotal - tenders.reduce((s, x) => s + x.amountCents, 0);
            if (remaining > 0) {
              setPaying({ ...paying, tenders });
              return { dueCents: remaining };
            }
            const { ok, order } = await submitDraft(draft, tenders);
            if (!ok) return null;
            setPaying({ ...paying, tenders, submitted: { order } });
            return { dueCents: 0 };
          }}
          onPayLater={async () => {
            const { ok } = await submitDraft(draft, paying.tenders);
            setPaying(null);
            if (ok) finishDraft(draft.mode);
          }}
          onReceipt={() => paying.submitted?.order && receipt(paying.submitted.order)}
          onClose={() => void closePaying()}
        />
      )}

      <ManagerPinDialog
        open={approval !== null}
        label={approval?.label ?? ""}
        error={approval?.error ?? null}
        busy={approval?.busy ?? false}
        onPin={(pin) => void onManagerPin(pin)}
        onCancel={() => {
          approval?.resolve(null);
          setApproval(null);
        }}
      />

      {dialog?.kind === "open_shift" && <OpenShiftDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "close_shift" && <CloseShiftDialog shiftId={dialog.shiftId} names={names} onClose={() => setDialog(null)} />}
      {dialog?.kind === "drawer" && <DrawerDialog kind={dialog.drawer} onClose={() => setDialog(null)} />}
      {dialog?.kind === "outbox" && (
        <OutboxDialog
          queue={queue}
          online={online}
          lastSync={lastSync}
          timeZone={store.timeZone}
          onPrint={(e) => print(<FallbackTicket req={e.request} lines={slipLines(e.request, menu)} at={e.createdAt} timeZone={store.timeZone} />)}
          onRetry={async (e) => {
            const out = await outbox.retry(e.orderId);
            if (out?.kind === "sent") notify.success(`#${out.order.number} sent`);
            else if (out) notify.error(out.kind === "rejected" ? out.message : "Still can't reach the server.");
          }}
          onDiscard={(e) => void outbox.discard(e.orderId)}
          onClose={() => setDialog(null)}
        />
      )}
      {portal}
    </PosContext.Provider>
  );
}

function NotSentList({ queue, onOpen }: { queue: outbox.OutboxEntry[]; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="rounded-2xl border-2 border-destructive bg-destructive/5 p-3 text-left" data-testid="not-sent">
      <p className="font-bold text-destructive">NOT SENT · the kitchen screen has not received these</p>
      <ul className="text-sm">
        {queue.map((e) => (
          <li key={e.orderId}>
            ID {e.orderId.slice(-6).toUpperCase()} · {e.request.customer?.name ?? "Walk-in"} · {e.request.lines.length} line{e.request.lines.length === 1 ? "" : "s"}
            {e.state === "rejected" && <b className="text-destructive"> · refused: {e.lastError}</b>}
          </li>
        ))}
      </ul>
    </button>
  );
}

function OutboxDialog({
  queue,
  online,
  lastSync,
  timeZone,
  onPrint,
  onRetry,
  onDiscard,
  onClose,
}: {
  queue: outbox.OutboxEntry[];
  online: boolean;
  lastSync: number;
  timeZone: string;
  onPrint: (e: outbox.OutboxEntry) => void;
  onRetry: (e: outbox.OutboxEntry) => void;
  onDiscard: (e: outbox.OutboxEntry) => void;
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
                    {e.state === "pending" ? "NOT SENT" : "REFUSED"} · ID {e.orderId.slice(-6).toUpperCase()}
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
                <button type="button" className="flex size-11 items-center justify-center rounded-lg hover:bg-muted" onClick={() => onRetry(e)} aria-label="Retry now">
                  <RotateCw className="size-5" />
                </button>
                {e.state === "rejected" && (
                  <button type="button" className="flex size-11 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10" onClick={() => onDiscard(e)} aria-label="Discard">
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

