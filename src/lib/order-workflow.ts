/**
 * Order lifecycle rules: which status moves are legal, what each move stamps,
 * and how the admin labels them. Every writer (admin, KDS, checkout) goes
 * through these tables. Shared by server and client — no I/O.
 */

export const ORDER_STATUSES = [
  "new",
  "confirmed",
  "preparing",
  "ready",
  "completed",
  "canceled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ACTIVE_STATUSES = ["new", "confirmed", "preparing", "ready"] as const;

export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ["confirmed", "canceled"],
  confirmed: ["preparing", "canceled"],
  preparing: ["ready", "canceled"],
  ready: ["completed", "canceled"],
  completed: [],
  canceled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * The kitchen's undo edge, outside the forward table on purpose: only the
 * KDS recall takes an order backwards, and it always lands on "preparing".
 */
export const RECALLABLE: readonly OrderStatus[] = ["ready", "completed"];

/** The one forward move the admin offers as the primary button. */
export const NEXT_ACTION: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  new: { to: "confirmed", label: "Confirm" },
  confirmed: { to: "preparing", label: "Start preparing" },
  preparing: { to: "ready", label: "Mark ready" },
  ready: { to: "completed", label: "Complete" },
};

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

export const STATUS_META: Record<
  OrderStatus,
  { label: string; variant: BadgeVariant; className?: string }
> = {
  new: {
    label: "New",
    variant: "outline",
    className: "border-transparent! bg-warning/10 text-warning!",
  },
  confirmed: { label: "Confirmed", variant: "secondary" },
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

export const PAYMENT_METHODS = ["cash", "card", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: "Cash",
  card: "Card",
  other: "Other",
};

export const ORDER_EVENT_TYPES = [
  "placed",
  "status_changed",
  "eta_changed",
  "payment_recorded",
  "note_added",
] as const;
export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];

/** Statuses where the food is still owed, so a passed promise means late. */
const COOKING: readonly OrderStatus[] = ["new", "confirmed", "preparing"];

export function isLate(promisedAt: Date | null, status: OrderStatus, now: Date): boolean {
  return promisedAt !== null && COOKING.includes(status) && now.getTime() > promisedAt.getTime();
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
 * The timestamp columns a move into `to` writes. Landing on "preparing"
 * clears readyAt/completedAt, which is what makes a KDS recall honest.
 */
export function statusTimestamps(to: OrderStatus, now: Date): StatusTimestamps {
  switch (to) {
    case "new":
    case "confirmed":
      return {};
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
