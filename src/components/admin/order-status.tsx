import type { orders } from "@/db";
import { formatClock } from "@/lib/hours";
import {
  minutesUntil,
  PAYMENT_METHOD_LABEL,
  STATUS_META,
  type OrderStatus,
} from "@/lib/order-workflow";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

type Order = typeof orders.$inferSelect;

export function StatusBadge({ status }: { status: OrderStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant={meta.variant} className={meta.className}>
      {meta.label}
    </Badge>
  );
}

export function PaymentBadge({
  status,
  method,
}: {
  status: Order["paymentStatus"];
  method: Order["paymentMethod"];
}) {
  if (status === "paid") {
    return (
      <Badge variant="outline" className="text-success!">
        Paid{method ? ` · ${PAYMENT_METHOD_LABEL[method]}` : ""}
      </Badge>
    );
  }
  if (status === "refunded") {
    return (
      <Badge variant="outline" className="text-muted-foreground!">
        Refunded
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-warning!">
      Unpaid
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
