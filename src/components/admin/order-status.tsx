import type { orders } from "@/db";
import { PAYMENT_METHOD_LABEL, STATUS_META, type OrderStatus } from "@/lib/order-workflow";
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
