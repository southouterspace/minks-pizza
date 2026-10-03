import type { InferSelectModel } from "drizzle-orm";
import type { orderItems, orders } from "@/db";
import { formatCents } from "@/lib/money";
import { PAYMENT_LABEL, channelLabel, dueCents, paymentState, type PaymentState } from "@/lib/orders";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

const TYPE_LABEL: Record<AdminOrder["orderType"], string> = {
  pickup: "Pickup",
  delivery: "Delivery",
  dine_in: "Dine-in",
};

function modifierLabel(m: AdminOrder["items"][number]["modifiers"][number]): string {
  if (m.kind === "option") return `${m.groupName}: ${m.modifierName}`;
  const amount = m.amount === "regular" ? "" : `${m.amount} `;
  const half = m.placement === "whole" ? "" : ` (${m.placement} half)`;
  return `${amount}${m.modifierName}${half}`;
}

export function StatusBadge({ status }: { status: OrderStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant={meta.variant} className={meta.className}>
      {meta.label}
    </Badge>
  );
}

const PAYMENT_TONE: Record<PaymentState, string> = {
  paid: "text-success!",
  partial: "text-warning!",
  unpaid: "text-warning!",
  refunded: "text-muted-foreground!",
};

function PaymentPill({ order }: { order: AdminOrder }) {
  const state = paymentState(order);
  const due = dueCents(order);
  return (
    <Badge variant="outline" className={PAYMENT_TONE[state]}>
      {PAYMENT_LABEL[state]}
      {state === "partial" || (state === "unpaid" && due > 0) ? ` · ${formatCents(due)} due` : ""}
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
  const isDelivery = order.orderType === "delivery";

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold tabular-nums">
            #{order.orderNumber}
          </span>
          <StatusBadge status={order.status} />
          <Badge variant="secondary">{channelLabel(order.channel, order.orderType)}</Badge>
          <Badge variant="outline" className="text-muted-foreground!">
            {TYPE_LABEL[order.orderType]}
            {order.orderType === "dine_in" && order.tableLabel ? ` · Table ${order.tableLabel}` : ""}
          </Badge>
          <PaymentPill order={order} />
        </CardTitle>
        <CardAction className="text-right text-xs text-muted-foreground">
          {formatDateTime(order.placedAt)}
          {order.status === "held" && order.fireAt ? (
            <span className="block">Fires {formatDateTime(order.fireAt)}</span>
          ) : null}
          {order.promisedAt ? (
            <span className="block">Promised {formatDateTime(order.promisedAt)}</span>
          ) : null}
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
            <li
              key={line.id}
              className={line.voidedAt ? "text-sm text-muted-foreground line-through" : "text-sm"}
            >
              <div className="flex items-baseline justify-between gap-4">
                <span>
                  {line.voidedAt ? (
                    <span className="mr-1 font-semibold text-destructive no-underline">VOID</span>
                  ) : null}
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
                  {line.modifiers.map(modifierLabel).join(" · ")}
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
            <TotalRow label="Discounts" value={`−${formatCents(order.discountCents)}`} />
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

      </CardFooter>
    </Card>
  );
}
