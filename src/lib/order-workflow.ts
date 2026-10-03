/**
 * Order lifecycle rules: which status moves are legal, what each move stamps,
 * and how the admin labels them. Kitchen status is derived from line stamps by
 * the fold in orders-server/folds.ts; `held` = nothing fired yet (scheduled or
 * an open check). Every writer (POS, KDS, admin, checkout) logs its moves
 * through order-writes.ts. Shared by server and client: no I/O.
 */

export const ORDER_STATUSES = [
  "held",
  "new",
  "preparing",
  "ready",
  "completed",
  "canceled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ACTIVE_STATUSES = ["held", "new", "preparing", "ready"] as const;

/** Food still owed: a passed promise means late, and the promise can still move. */
export const COOKING_STATUSES = ["held", "new", "preparing"] as const;

export function isActive(status: OrderStatus): boolean {
  return (ACTIVE_STATUSES as readonly OrderStatus[]).includes(status);
}

export function isCooking(status: OrderStatus): boolean {
  return (COOKING_STATUSES as readonly OrderStatus[]).includes(status);
}

export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  held: ["new", "canceled"],
  new: ["preparing", "ready", "canceled"],
  preparing: ["ready", "canceled"],
  ready: ["completed", "canceled"],
  completed: [],
  canceled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * The kitchen's undo edges, outside the forward table on purpose: the KDS
 * recall takes an order back to "preparing", and firing a course onto a
 * finished check takes it back to "new".
 */
export const RECALLABLE: readonly OrderStatus[] = ["ready", "completed"];

/**
 * The one forward move the admin offers as the primary button. Cooking
 * stages move with the kitchen's taps, not from the office.
 */
export const NEXT_ACTION: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  ready: { to: "completed", label: "Complete" },
};

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

export const STATUS_META: Record<
  OrderStatus,
  { label: string; variant: BadgeVariant; className?: string }
> = {
  held: { label: "Scheduled", variant: "outline" },
  new: {
    label: "New",
    variant: "outline",
    className: "border-transparent! bg-warning/10 text-warning!",
  },
  preparing: { label: "Preparing", variant: "secondary" },
  ready: {
    label: "Ready",
    variant: "outline",
    className: "border-transparent! bg-success/10 text-success!",
  },
  completed: {
    label: "Completed",
    variant: "secondary",
    className: "text-muted-foreground!",
  },
  canceled: { label: "Canceled", variant: "destructive" },
};

export const CANCEL_REASONS = [
  "Customer request",
  "Out of stock",
  "Kitchen too busy",
  "Duplicate order",
  "Unable to deliver",
  "Other",
] as const;

/**
 * `payment_recorded` is no longer written (tenders are the payment record);
 * it stays so rows logged before the ledger existed still read.
 */
export const ORDER_EVENT_TYPES = [
  "placed",
  "status_changed",
  "eta_changed",
  "payment_recorded",
  "note_added",
  "discount",
] as const;
export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];

/**
 * Staff can discount or comp while nothing has been paid and the order is
 * open. Money already taken comes back through a refund, not a discount.
 */
export function canComp(order: { status: OrderStatus; paidCents: number }): boolean {
  return order.paidCents === 0 && order.status !== "canceled" && order.status !== "completed";
}

export function isLate(promisedAt: Date | null, status: OrderStatus, now: Date): boolean {
  return promisedAt !== null && isCooking(status) && now.getTime() > promisedAt.getTime();
}

/** The timeline headline for one audit event. */
export function describeEvent(e: {
  type: OrderEventType;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
}): string {
  switch (e.type) {
    case "placed":
      return "Order placed";
    case "status_changed":
      if (!e.toStatus) return "Status changed";
      if (e.toStatus === "canceled") return "Canceled";
      if (e.toStatus === "preparing" && e.fromStatus && RECALLABLE.includes(e.fromStatus)) {
        return "Recalled to the kitchen";
      }
      if (e.toStatus === "new") return e.fromStatus && RECALLABLE.includes(e.fromStatus) ? "More food fired" : "Sent to kitchen";
      return STATUS_META[e.toStatus].label;
    case "eta_changed":
      return "Promised time pushed";
    case "payment_recorded":
      return "Payment recorded";
    case "note_added":
      return "Note";
    case "discount":
      return "Discount";
  }
}

/** Whole minutes until the promise, negative once it has passed. */
export function minutesUntil(promisedAt: Date, now: Date): number {
  return Math.round((promisedAt.getTime() - now.getTime()) / 60_000);
}

export type StatusTimestamps = {
  readyAt?: Date | null;
  completedAt?: Date | null;
  canceledAt?: Date;
};

/**
 * The timestamp columns a move into `to` writes. Landing on "new" or
 * "preparing" clears readyAt/completedAt, which is what makes a KDS recall
 * (and a course fired onto a finished check) honest.
 */
export function statusTimestamps(to: OrderStatus, now: Date): StatusTimestamps {
  switch (to) {
    case "held":
      return {};
    case "new":
    case "preparing":
      return { readyAt: null, completedAt: null };
    case "ready":
      return { readyAt: now };
    case "completed":
      return { completedAt: now };
    case "canceled":
      return { canceledAt: now };
  }
}
