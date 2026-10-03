import type { InferSelectModel } from "drizzle-orm";
import type { courierDeliveries, orderItems, orders } from "@/db";
import { updateOrderStatus } from "@/app/admin/actions";
import {
  COURIER_PROVIDER_LABEL,
  COURIER_STATUS_LABEL,
  isTerminal,
  type CourierProviderId,
} from "@/lib/delivery/types";
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
import { CancelCourierForm, RequestCourierForm } from "./courier-forms";
import { formatDateTime } from "./ui";

type CourierDelivery = InferSelectModel<typeof courierDeliveries>;

export type AdminOrder = InferSelectModel<typeof orders> & {
  items: InferSelectModel<typeof orderItems>[];
  /** The latest one only. */
  courierDeliveries: CourierDelivery[];
};

export type CourierOption = { id: CourierProviderId; label: string };

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

const SOURCE_LABEL: Record<AdminOrder["source"], string> = {
  web: "Web",
  doordash: "DoorDash",
  ubereats: "Uber Eats",
  grubhub: "Grubhub",
};

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

function CourierRow({
  orderId,
  delivery,
  providers,
}: {
  orderId: string;
  delivery: CourierDelivery | undefined;
  providers: CourierOption[];
}) {
  const live = delivery && !isTerminal(delivery.status);
  if (!delivery && providers.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-xs">
      {delivery ? (
        <>
          <span className="font-medium">{COURIER_PROVIDER_LABEL[delivery.provider]}</span>
          <Badge
            variant={
              delivery.status === "canceled" || delivery.status === "returned"
                ? "destructive"
                : "secondary"
            }
          >
            {COURIER_STATUS_LABEL[delivery.status]}
          </Badge>
          {delivery.feeCents !== null ? (
            <span className="tabular-nums text-muted-foreground">
              {formatCents(delivery.feeCents)} fee
            </span>
          ) : null}
          {delivery.courierName ? (
            <span>
              {delivery.courierName}
              {delivery.courierPhone ? (
                <span className="text-muted-foreground"> · {delivery.courierPhone}</span>
              ) : null}
            </span>
          ) : null}
          {delivery.trackingUrl ? (
            <a
              href={delivery.trackingUrl}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Track
            </a>
          ) : null}
        </>
      ) : null}
      <div className="ml-auto">
        {live ? (
          <CancelCourierForm deliveryId={delivery.id} />
        ) : providers.length > 0 ? (
          <RequestCourierForm orderId={orderId} providers={providers} />
        ) : null}
      </div>
    </div>
  );
}

export function OrderCard({
  order,
  courierProviders,
}: {
  order: AdminOrder;
  courierProviders: CourierOption[];
}) {
  const next = NEXT_ACTION[order.status];
  const cancelable = CANCELABLE.includes(order.status);
  const isDelivery = order.orderType === "delivery";

  return (
    <Card>
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
          {order.source !== "web" ? (
            <Badge variant="outline">
              {SOURCE_LABEL[order.source]}
              {order.sourceDisplayId ? ` · ${order.sourceDisplayId}` : ""}
            </Badge>
          ) : null}
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

        {isDelivery && order.source === "web" ? (
          <CourierRow
            orderId={order.id}
            delivery={order.courierDeliveries[0]}
            providers={courierProviders}
          />
        ) : null}
      </CardContent>

      {/* Money + actions */}
      <CardFooter className="flex-wrap items-end justify-between gap-4">
        <dl className="space-y-0.5 text-xs">
          <TotalRow label="Subtotal" value={formatCents(order.subtotalCents)} />
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
