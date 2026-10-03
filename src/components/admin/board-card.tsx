import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { orderItems, orders } from "@/db";
import { adjustPromisedTimeAction, moveOrder } from "@/app/admin/actions";
import { formatCents } from "@/lib/money";
import { canTransition, isLate, minutesUntil, NEXT_ACTION } from "@/lib/order-workflow";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { ActionForm, CancelOrderDialog, SubmitButton } from "./order-actions";
import { LateBadge, PaymentBadge, StatusBadge } from "./order-status";
import { formatAge, formatClock } from "./ui";

export type BoardOrder = typeof orders.$inferSelect & {
  items: (typeof orderItems.$inferSelect)[];
};

export function itemSummary(items: BoardOrder["items"]): string {
  return items
    .map((i) => (i.quantity > 1 ? `${i.quantity}× ${i.itemName}` : i.itemName))
    .join(", ");
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

export function BoardCard({
  order,
  now,
  timeZone,
}: {
  order: BoardOrder;
  now: Date;
  timeZone: string;
}) {
  const next = NEXT_ACTION[order.status];
  const late = isLate(order.promisedAt, order.status, now);
  const itemCount = order.items.reduce((n, i) => n + i.quantity, 0);

  return (
    <Card
      size="sm"
      data-testid={`board-order-${order.orderNumber}`}
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
          {order.status === "confirmed" || order.status === "preparing" ? (
            <StatusBadge status={order.status} />
          ) : null}
          {order.paymentStatus !== "pending" ? (
            <PaymentBadge status={order.paymentStatus} method={order.paymentMethod} />
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t px-3 pt-2">
        {next ? (
          <ActionForm action={moveOrder} orderId={order.id}>
            <input type="hidden" name="to" value={next.to} />
            <SubmitButton size="sm" data-testid={`advance-${order.orderNumber}`}>
              {next.label}
            </SubmitButton>
          </ActionForm>
        ) : null}
        {(order.status === "ready" ? [] : [5, 10]).map((m) => (
          <ActionForm key={m} action={adjustPromisedTimeAction} orderId={order.id}>
            <input type="hidden" name="minutes" value={m} />
            <SubmitButton
              size="sm"
              variant="ghost"
              className="tabular-nums text-muted-foreground"
              aria-label={`Push promised time ${m} minutes`}
              data-testid={`plus${m}-${order.orderNumber}`}
            >
              +{m}
            </SubmitButton>
          </ActionForm>
        ))}
        <span className="flex-1" />
        {canTransition(order.status, "canceled") ? (
          <CancelOrderDialog orderId={order.id} orderNumber={order.orderNumber} />
        ) : null}
      </div>
    </Card>
  );
}
