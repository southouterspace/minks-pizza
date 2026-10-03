import { dueCents } from "@/lib/orders";
import { formatClock } from "@/lib/zoned";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatCents } from "@/lib/money";
import { isLate } from "@/lib/order-workflow";
import type { OrderWithItems } from "@/lib/order-queries";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { AdvanceButton, CancelOrderDialog, EtaButtons } from "./order-actions";
import { LateBadge, PaymentBadge, PromisedTime, StatusBadge } from "./order-status";
import { formatAge } from "./ui";

function itemSummary(items: OrderWithItems["items"]): string {
  return items
    .map((i) => (i.quantity > 1 ? `${i.quantity}× ${i.itemName}` : i.itemName))
    .join(", ");
}

export function BoardCard({
  order,
  now,
  timeZone,
}: {
  order: OrderWithItems;
  now: Date;
  timeZone: string;
}) {
  const late = isLate(order.promisedAt, order.status, now);
  const itemCount = order.items.reduce((n, i) => n + i.quantity, 0);

  return (
    <Card
      size="sm"
      data-testid={`board-order-${order.orderNumber}`}
      data-order-number={order.orderNumber}
      className={cn("gap-2!", late && "ring-destructive/40")}
    >
      <div className="flex items-start justify-between gap-2 px-3">
        <Link
          href={`/admin/orders/${order.id}`}
          className="group min-w-0"
          data-testid={`board-detail-${order.orderNumber}`}
        >
          <p className="flex items-center gap-1.5 text-sm font-semibold tabular-nums">
            #{order.orderNumber}
            <span className="truncate font-medium">{order.customerName}</span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </p>
          <p className="text-xs text-muted-foreground">
            {order.orderType === "delivery" ? "Delivery" : "Pickup"} · {itemCount}{" "}
            {itemCount === 1 ? "item" : "items"} · {formatCents(order.totalCents)}
          </p>
        </Link>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-xs tabular-nums text-muted-foreground" title="Since placed">
            {formatAge(order.placedAt, now)}
          </span>
          {late ? <LateBadge /> : null}
        </div>
      </div>

      <div className="space-y-1 px-3 text-xs">
        <p className="line-clamp-2">{itemSummary(order.items)}</p>
        {order.orderNotes ? (
          <p className="line-clamp-1 rounded bg-muted px-2 py-1 text-muted-foreground">
            Note: {order.orderNotes}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <PromisedTime promisedAt={order.promisedAt} late={late} now={now} timeZone={timeZone} />
          {order.status === "preparing" || order.status === "held" ? <StatusBadge status={order.status} /> : null}
          <PaymentBadge order={order} />
          {dueCents(order) > 0 ? (
            <Link href={`/pos?order=${order.id}`} className="text-xs font-medium underline underline-offset-4">
              Collect {formatCents(dueCents(order))} at POS
            </Link>
          ) : null}
          {order.status === "held" && order.fireAt ? (
            <span className="text-muted-foreground">Fires {formatClock(order.fireAt, timeZone)}</span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t px-3 pt-2">
        <AdvanceButton
          orderId={order.id}
          status={order.status}
          size="sm"
          testId={`advance-${order.orderNumber}`}
        />
        <EtaButtons
          orderId={order.id}
          orderNumber={order.orderNumber}
          status={order.status}
          minutes={[5, 10]}
        />
        <span className="flex-1" />
        <CancelOrderDialog
          orderId={order.id}
          orderNumber={order.orderNumber}
          status={order.status}
          size="sm"
        />
      </div>
    </Card>
  );
}
