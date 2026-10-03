import type { InferSelectModel } from "drizzle-orm";
import type { orderItems, orders } from "@/db";
import { updateOrderStatus } from "@/app/admin/actions";
import { formatCents } from "@/lib/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmButton } from "./confirm-button";
import { formatDateTime } from "./ui";

export type AdminOrder = InferSelectModel<typeof orders> & {
  items: InferSelectModel<typeof orderItems>[];
};

type OrderStatus = AdminOrder["status"];
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

const NEXT_ACTION: Partial<
  Record<OrderStatus, { status: OrderStatus; label: string }>
> = {
  new: { status: "confirmed", label: "Confirm" },
  confirmed: { status: "preparing", label: "Start preparing" },
  preparing: { status: "ready", label: "Mark ready" },
  ready: { status: "completed", label: "Complete" },
};

const CANCELABLE: readonly OrderStatus[] = ["new", "confirmed"];

export function StatusBadge({ status }: { status: OrderStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant={meta.variant} className={meta.className}>
      {meta.label}
    </Badge>
  );
}

function PaymentPill({ status }: { status: AdminOrder["paymentStatus"] }) {
  if (status === "paid") {
    return (
      <Badge variant="outline" className="text-success!">
        Paid
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
      Payment pending
    </Badge>
  );
}

function TotalRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      className={
        strong
          ? "flex justify-between gap-8 pt-1 text-sm font-semibold"
          : "flex justify-between gap-8"
      }
    >
      <dt className={strong ? undefined : "text-muted-foreground"}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

export function OrderCard({ order }: { order: AdminOrder }) {
  const next = NEXT_ACTION[order.status];
  const cancelable = CANCELABLE.includes(order.status);
  const isDelivery = order.orderType === "delivery";

  return (
    <Card data-testid={`order-card-${order.orderNumber}`}>
      <CardHeader className="border-b">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold tabular-nums">
            #{order.orderNumber}
          </span>
          <StatusBadge status={order.status} />
          <Badge variant="outline" className="text-muted-foreground!">
            {isDelivery ? "Delivery" : "Pickup"}
          </Badge>
          <PaymentPill status={order.paymentStatus} />
        </CardTitle>
        <CardAction className="text-xs text-muted-foreground">
          {formatDateTime(order.placedAt)}
        </CardAction>
      </CardHeader>

      {/* Customer + items */}
      <CardContent>
        <p className="text-sm">
          <span className="font-medium">{order.customerName}</span>
          <span className="text-muted-foreground">
            {" "}
            · {order.customerPhone}
          </span>
        </p>
        {isDelivery && order.addressLine1 ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {order.addressLine1}
            {order.addressLine2 ? `, ${order.addressLine2}` : ""}
            {order.city ? `, ${order.city}` : ""}
            {order.zip ? ` ${order.zip}` : ""}
          </p>
        ) : null}

        <ul className="mt-3 space-y-2">
          {order.items.map((line) => (
            <li key={line.id} className="text-sm">
              <div className="flex items-baseline justify-between gap-4">
                <span>
                  <span className="font-medium tabular-nums">
                    {line.quantity} ×
                  </span>{" "}
                  {line.itemName}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {formatCents(line.lineTotalCents)}
                </span>
              </div>
              {line.modifiers.length > 0 ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {line.modifiers
                    .map((m) => `${m.groupName}: ${m.modifierName}`)
                    .join(" · ")}
                </p>
              ) : null}
              {line.notes ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  “{line.notes}”
                </p>
              ) : null}
            </li>
          ))}
        </ul>

        {order.orderNotes ? (
          <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Order note:</span>{" "}
            {order.orderNotes}
          </p>
        ) : null}
      </CardContent>

      {/* Money + actions */}
      <CardFooter className="flex-wrap items-end justify-between gap-4">
        <dl className="space-y-0.5 text-xs">
          <TotalRow label="Subtotal" value={formatCents(order.subtotalCents)} />
          {order.discountCents > 0 ? (
            <TotalRow
              label={order.loyaltyRewardName ?? "Reward"}
              value={`−${formatCents(order.discountCents)}`}
            />
          ) : null}
          <TotalRow label="Tax" value={formatCents(order.taxCents)} />
          {isDelivery || order.deliveryFeeCents > 0 ? (
            <TotalRow
              label="Delivery fee"
              value={formatCents(order.deliveryFeeCents)}
            />
          ) : null}
          {order.tipCents > 0 ? (
            <TotalRow label="Tip" value={formatCents(order.tipCents)} />
          ) : null}
          <TotalRow
            label="Total"
            value={formatCents(order.totalCents)}
            strong
          />
        </dl>

        <div className="flex items-center gap-2">
          {cancelable ? (
            <form action={updateOrderStatus}>
              <input type="hidden" name="orderId" value={order.id} />
              <input type="hidden" name="status" value="canceled" />
              <ConfirmButton
                label="Cancel"
                confirmLabel="Confirm cancel"
                size="default"
                variant="outline"
              />
            </form>
          ) : null}
          {next ? (
            <form action={updateOrderStatus}>
              <input type="hidden" name="orderId" value={order.id} />
              <input type="hidden" name="status" value={next.status} />
              <Button type="submit">{next.label}</Button>
            </form>
          ) : null}
        </div>
      </CardFooter>
    </Card>
  );
}
