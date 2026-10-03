/**
 * Kitchen display domain: the wire types the display renders, and the pure
 * rules it applies to them (station routing, ticket timers, pizza-aware
 * modifier layout, all-day counts). Shared by server and client — no I/O.
 */
import type { OrderStatus } from "@/lib/order-workflow";
import type { Fulfillment, OrderSource } from "@/lib/orders";
import type { LineModifier } from "@/lib/pricing";

export const KITCHEN_STATIONS = ["pizza", "kitchen", "counter"] as const;
export type KitchenStation = (typeof KITCHEN_STATIONS)[number];

export const STATION_LABEL: Record<KitchenStation, string> = {
  pizza: "Pizza line",
  kitchen: "Kitchen",
  counter: "Counter (no prep)",
};

/**
 * What one screen shows. Pies move make line → oven → cut, so the pizza
 * station gets two screens; `all` is the expo / single-screen view.
 */
export const KDS_VIEWS = ["all", "make", "oven", "kitchen"] as const;
export type KdsView = (typeof KDS_VIEWS)[number];

export const VIEW_LABEL: Record<KdsView, string> = {
  all: "All",
  make: "Make line",
  oven: "Oven",
  kitchen: "Kitchen",
};

export type KdsItem = {
  id: number;
  name: string;
  quantity: number;
  station: KitchenStation;
  modifiers: LineModifier[];
  notes: string | null;
  ovenAt: string | null;
  doneAt: string | null;
  /** A line voided after it was sent stays on the ticket, struck through. */
  voidedAt: string | null;
};

/** One ticket. Lines split onto another check ride on their parent's ticket. */
export type KdsOrder = {
  id: string;
  number: number;
  status: OrderStatus;
  source: OrderSource;
  fulfillment: Fulfillment;
  fireAt: string | null;
  promisedAt: string | null;
  customerName: string;
  customerPhone: string;
  notes: string | null;
  placedAt: string;
  readyAt: string | null;
  items: KdsItem[];
};

export type KdsTiming = {
  warnMinutes: number;
  lateMinutes: number;
  ovenMinutes: number;
};

export type KdsSnapshot = {
  serverNow: string;
  timing: KdsTiming;
  /** Orders still being made, oldest first. */
  line: KdsOrder[];
  /** Bumped and waiting for the customer or driver, oldest first. */
  ready: KdsOrder[];
  /** Recently bumped (ready or handed off), newest first — the recall list. */
  recent: KdsOrder[];
  /** Orders canceled in the last half hour. */
  canceled: { id: string; number: number }[];
  /** Mean placed→ready time over the last two hours, if anything was bumped. */
  avgTicketSeconds: number | null;
};

/** A voided line stays on the ticket in the "void" stage, which no screen works on. */
export type ItemStage = "queued" | "oven" | "done" | "void";
/** The stages a cook can move a line to. */
export type WorkStage = Exclude<ItemStage, "void">;

export type KdsAction =
  | { type: "item"; itemId: number; stage: WorkStage }
  | { type: "bump"; orderId: string; view: KdsView }
  | { type: "recall"; orderId: string }
  | { type: "handoff"; orderId: string };

// ---------------------------------------------------------------------------
// Item stages and routing
// ---------------------------------------------------------------------------

type Staged = Pick<KdsItem, "ovenAt" | "doneAt" | "voidedAt">;

export function stageOf(item: Staged): ItemStage {
  if (item.voidedAt !== null) return "void";
  if (item.doneAt !== null) return "done";
  if (item.ovenAt !== null) return "oven";
  return "queued";
}

/** Counter items and voided lines never hold an order back: nothing to cook. */
export function needsKitchen(item: Staged & Pick<KdsItem, "station">): boolean {
  return item.station !== "counter" && stageOf(item) !== "void";
}

export function itemsFor(order: KdsOrder, view: KdsView): KdsItem[] {
  switch (view) {
    case "all":
      return order.items;
    case "make":
      return order.items.filter((i) => i.station === "pizza");
    case "oven":
      return order.items.filter((i) => i.station === "pizza" && i.ovenAt !== null);
    case "kitchen":
      return order.items.filter((i) => i.station === "kitchen");
  }
}

/** The stage a view's bump (or a tap on a waiting item) moves work to. */
function targetStage(item: KdsItem, view: KdsView): WorkStage {
  return item.station === "pizza" && (view === "make" || (view === "all" && stageOf(item) === "queued"))
    ? "oven"
    : "done";
}

/** Whether a view still has work on this item. */
export function isPending(item: KdsItem, view: KdsView): boolean {
  const stage = stageOf(item);
  if (view === "make") return stage === "queued";
  if (view === "oven") return stage === "oven";
  return stage !== "done" && needsKitchen(item);
}

/** A station screen drops a ticket once it has nothing left to do on it. */
export function showsOnLine(order: KdsOrder, view: KdsView): boolean {
  return view === "all" || itemsFor(order, view).some((i) => isPending(i, view));
}

/**
 * Tapping an item advances it one stage for this view; tapping it again
 * undoes that, so a mis-tap costs one more tap rather than a recall.
 */
export function tapStage(item: KdsItem, view: KdsView): WorkStage {
  const stage = stageOf(item);
  if (view === "make") return stage === "queued" ? "oven" : "queued";
  if (view === "oven") return stage === "oven" ? "done" : "oven";
  if (stage === "done") return "queued";
  return targetStage(item, view);
}

/** The expo bump also finishes counter items, so the POS shows them done. */
const expoPending = (i: KdsItem) => stageOf(i) === "queued" || stageOf(i) === "oven";

export function bumpPlan(order: KdsOrder, view: KdsView): { item: KdsItem; stage: WorkStage }[] {
  return itemsFor(order, view)
    .filter((i) => (view === "all" ? expoPending(i) : isPending(i, view)))
    .map((item) => ({ item, stage: view === "all" ? "done" : targetStage(item, view) }));
}

/** An order is ready once every item that needs cooking is finished. */
export function kitchenComplete(items: (Staged & Pick<KdsItem, "station">)[]): boolean {
  return items.every((i) => !needsKitchen(i) || i.doneAt !== null);
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

export type TimerLevel = "ok" | "warn" | "late";

export function timerLevel(ageMs: number, timing: KdsTiming): TimerLevel {
  const minutes = ageMs / 60_000;
  if (minutes >= timing.lateMinutes) return "late";
  if (minutes >= timing.warnMinutes) return "warn";
  return "ok";
}

/** 754_000 → "12:34"; an hour or more → "1:02:03". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// ---------------------------------------------------------------------------
// Pizza-aware ticket layout
// ---------------------------------------------------------------------------

export type TicketMod = { label: string; kind: "add" | "remove" | "amount" | "option" };

export type TicketLine = {
  /** Size and crust lead the ticket: they decide which dough ball to grab. */
  size: string | null;
  crust: string | null;
  /** Whole-pie toppings and every other option, in entry order. */
  whole: TicketMod[];
  /** Half toppings, in their own blocks so a half can't be misread. */
  left: TicketMod[];
  right: TicketMod[];
};

function placedMod(m: Extract<LineModifier, { kind: "placed" }>): TicketMod {
  switch (m.amount) {
    case "regular":
      return { label: m.modifierName, kind: "add" };
    case "extra":
      return { label: `Extra ${m.modifierName}`, kind: "amount" };
    case "light":
      return { label: `Light ${m.modifierName}`, kind: "amount" };
    case "none":
      return { label: `No ${m.modifierName}`, kind: "remove" };
  }
}

export function ticketLine(modifiers: LineModifier[]): TicketLine {
  const line: TicketLine = { size: null, crust: null, whole: [], left: [], right: [] };
  for (const m of modifiers) {
    if (m.kind === "placed") {
      line[m.placement].push(placedMod(m));
    } else if (m.role === "size" && line.size === null) {
      line.size = m.modifierName;
    } else if (m.role === "crust" && line.crust === null) {
      line.crust = m.modifierName;
    } else {
      line.whole.push({ label: `${m.groupName}: ${m.modifierName}`, kind: "option" });
    }
  }
  return line;
}

// ---------------------------------------------------------------------------
// All-day counts
// ---------------------------------------------------------------------------

export type AllDayRow = { key: string; name: string; size: string | null; quantity: number };

/**
 * Unmade quantities across every open ticket, grouped by item and size —
 * "6 × Large Pepperoni" lets the line stretch dough ahead of the tickets.
 */
export function allDay(orders: KdsOrder[], view: KdsView): AllDayRow[] {
  const rows = new Map<string, AllDayRow>();
  for (const order of orders) {
    for (const item of itemsFor(order, view)) {
      if (!isPending(item, view)) continue;
      const { size } = ticketLine(item.modifiers);
      const key = `${item.name}\u0000${size ?? ""}`;
      const row = rows.get(key);
      if (row) row.quantity += item.quantity;
      else rows.set(key, { key, name: item.name, size, quantity: item.quantity });
    }
  }
  return [...rows.values()].sort(
    (a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name),
  );
}

// ---------------------------------------------------------------------------
// Optimistic updates
// ---------------------------------------------------------------------------

function withStage(item: KdsItem, stage: WorkStage, nowIso: string): KdsItem {
  if (stage === "queued") return { ...item, ovenAt: null, doneAt: null };
  if (stage === "oven") {
    return item.station === "pizza"
      ? { ...item, ovenAt: item.ovenAt ?? nowIso, doneAt: null }
      : { ...item, doneAt: nowIso };
  }
  return { ...item, doneAt: nowIso };
}

/** Mirrors the server's status sync after an order's items change. */
function settle(snapshot: KdsSnapshot, order: KdsOrder, nowIso: string): KdsSnapshot {
  const others = snapshot.line.filter((o) => o.id !== order.id);
  if (kitchenComplete(order.items)) {
    const ready = { ...order, status: "ready" as const, readyAt: nowIso };
    return {
      ...snapshot,
      line: others,
      ready: [...snapshot.ready, ready],
      recent: [ready, ...snapshot.recent],
    };
  }
  const touched = order.items.some((i) => stageOf(i) === "oven" || stageOf(i) === "done");
  const status = touched && order.status !== "preparing" ? "preparing" : order.status;
  return {
    ...snapshot,
    line: snapshot.line.map((o) => (o.id === order.id ? { ...order, status } : o)),
  };
}

/**
 * Applies an action to the local snapshot the way the server will, so the
 * screen responds on touch. The server's answer replaces it moments later.
 */
export function applyLocally(snapshot: KdsSnapshot, action: KdsAction, nowIso: string): KdsSnapshot {
  switch (action.type) {
    case "item": {
      const order = snapshot.line.find((o) =>
        o.items.some((i) => i.id === action.itemId && stageOf(i) !== "void"),
      );
      if (!order) return snapshot;
      const items = order.items.map((i) =>
        i.id === action.itemId ? withStage(i, action.stage, nowIso) : i,
      );
      return settle(snapshot, { ...order, items }, nowIso);
    }
    case "bump": {
      const order = snapshot.line.find((o) => o.id === action.orderId);
      if (!order) return snapshot;
      const moves = new Map(bumpPlan(order, action.view).map((p) => [p.item.id, p.stage]));
      const items = order.items.map((i) => {
        const stage = moves.get(i.id);
        return stage ? withStage(i, stage, nowIso) : i;
      });
      return settle(snapshot, { ...order, items }, nowIso);
    }
    case "recall": {
      const order =
        snapshot.ready.find((o) => o.id === action.orderId) ??
        snapshot.recent.find((o) => o.id === action.orderId);
      if (!order) return snapshot;
      const back: KdsOrder = {
        ...order,
        status: "preparing",
        readyAt: null,
        items: order.items.map((i) => ({ ...i, ovenAt: null, doneAt: null })),
      };
      return {
        ...snapshot,
        line: [...snapshot.line, back].sort((a, b) => a.placedAt.localeCompare(b.placedAt)),
        ready: snapshot.ready.filter((o) => o.id !== order.id),
        recent: snapshot.recent.filter((o) => o.id !== order.id),
      };
    }
    case "handoff":
      return {
        ...snapshot,
        ready: snapshot.ready.filter((o) => o.id !== action.orderId),
        recent: snapshot.recent.map((o) =>
          o.id === action.orderId ? { ...o, status: "completed" } : o,
        ),
      };
  }
}
