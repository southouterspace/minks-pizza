import { formatClock } from "@/lib/zoned";
import { minutesUntil, STATUS_META, type OrderStatus } from "@/lib/order-workflow";
import { PAYMENT_LABEL, paymentState, type Totals } from "@/lib/orders";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export function StatusBadge({ status }: { status: OrderStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant={meta.variant} className={meta.className}>
      {meta.label}
    </Badge>
  );
}

const PAYMENT_TONE = {
  paid: "text-success!",
  partial: "text-warning!",
  unpaid: "text-warning!",
  refunded: "text-muted-foreground!",
} as const;

/** Derived from the tenders folded onto the order, never stored. */
export function PaymentBadge({ order }: { order: Pick<Totals, "totalCents" | "paidCents" | "refundedCents"> }) {
  const state = paymentState(order);
  return (
    <Badge variant="outline" className={PAYMENT_TONE[state]} data-testid="payment-badge">
      {PAYMENT_LABEL[state]}
    </Badge>
  );
}

export function LateBadge() {
  return (
    <Badge variant="destructive" data-testid="late-badge">
      Late
    </Badge>
  );
}

export function PromisedTime({
  promisedAt,
  late,
  now,
  timeZone,
}: {
  promisedAt: Date | null;
  late: boolean;
  now: Date;
  timeZone: string;
}) {
  if (!promisedAt) return <span className="text-muted-foreground">No promised time</span>;
  const minutes = minutesUntil(promisedAt, now);
  return (
    <span className={cn("tabular-nums", late ? "font-medium text-destructive" : "text-muted-foreground")}>
      Promised {formatClock(promisedAt, timeZone)}
      {late
        ? ` · ${-minutes} min late`
        : minutes >= 0 && minutes <= 120
          ? ` · in ${minutes} min`
          : ""}
    </span>
  );
}
