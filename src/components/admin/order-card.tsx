import type { InferSelectModel } from "drizzle-orm";
import type { orderItems, orders } from "@/db";
import { updateOrderStatus } from "@/app/admin/actions";
import { formatCents } from "@/lib/money";
import { ConfirmButton } from "./confirm-button";
import { formatDateTime, smallButtonClass } from "./ui";

export type AdminOrder = InferSelectModel<typeof orders> & {
  items: InferSelectModel<typeof orderItems>[];
};

type OrderStatus = AdminOrder["status"];

export const STATUS_META: Record<
  OrderStatus,
  { label: string; className: string }
> = {
  new: { label: "New", className: "bg-warning/10 text-warning" },
  confirmed: { label: "Confirmed", className: "bg-surface text-foreground" },
  preparing: { label: "Preparing", className: "bg-surface text-foreground" },
  ready: { label: "Ready", className: "bg-success/10 text-success" },
  completed: { label: "Completed", className: "bg-surface text-muted" },
  canceled: { label: "Canceled", className: "bg-error/10 text-error" },
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
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

function PaymentPill({ status }: { status: AdminOrder["paymentStatus"] }) {
  if (status === "paid") {
    return (
      <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-success">
        Paid
      </span>
    );
  }
  if (status === "refunded") {
    return (
      <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted">
        Refunded
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-warning">
      Payment pending
    </span>
  );
}

export function OrderCard({ order }: { order: AdminOrder }) {
  const next = NEXT_ACTION[order.status];
  const cancelable = CANCELABLE.includes(order.status);
  const isDelivery = order.orderType === "delivery";

  return (
    <article className="rounded-lg border border-border">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <span className="text-sm font-semibold tabular-nums">
          #{order.orderNumber}
        </span>
        <StatusBadge status={order.status} />
        <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted">
          {isDelivery ? "Delivery" : "Pickup"}
        </span>
        <PaymentPill status={order.paymentStatus} />
        <span className="ml-auto text-xs text-muted">
          {formatDateTime(order.placedAt)}
        </span>
      </div>

      {/* Customer + items */}
      <div className="px-4 py-3">
        <p className="text-sm">
          <span className="font-medium">{order.customerName}</span>
          <span className="text-muted"> · {order.customerPhone}</span>
        </p>
        {isDelivery && order.addressLine1 ? (
          <p className="mt-0.5 text-sm text-muted">
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
                <span className="tabular-nums text-muted">
                  {formatCents(line.lineTotalCents)}
                </span>
              </div>
              {line.modifiers.length > 0 ? (
                <p className="mt-0.5 text-xs text-muted">
                  {line.modifiers
                    .map((m) => `${m.groupName}: ${m.modifierName}`)
                    .join(" · ")}
                </p>
              ) : null}
              {line.notes ? (
                <p className="mt-0.5 text-xs text-faint">“{line.notes}”</p>
              ) : null}
            </li>
          ))}
        </ul>

        {order.orderNotes ? (
          <p className="mt-3 rounded-md bg-surface px-3 py-2 text-xs text-muted">
            <span className="font-medium text-foreground">Order note:</span>{" "}
            {order.orderNotes}
          </p>
        ) : null}
      </div>

      {/* Money + actions */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-t border-border px-4 py-3">
        <dl className="space-y-0.5 text-xs">
          <div className="flex justify-between gap-8">
            <dt className="text-muted">Subtotal</dt>
            <dd className="tabular-nums">{formatCents(order.subtotalCents)}</dd>
          </div>
          <div className="flex justify-between gap-8">
            <dt className="text-muted">Tax</dt>
            <dd className="tabular-nums">{formatCents(order.taxCents)}</dd>
          </div>
          {isDelivery || order.deliveryFeeCents > 0 ? (
            <div className="flex justify-between gap-8">
              <dt className="text-muted">Delivery fee</dt>
              <dd className="tabular-nums">
                {formatCents(order.deliveryFeeCents)}
              </dd>
            </div>
          ) : null}
          {order.tipCents > 0 ? (
            <div className="flex justify-between gap-8">
              <dt className="text-muted">Tip</dt>
              <dd className="tabular-nums">{formatCents(order.tipCents)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-8 pt-1 text-sm font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{formatCents(order.totalCents)}</dd>
          </div>
        </dl>

        <div className="flex items-center gap-2">
          {cancelable ? (
            <form action={updateOrderStatus}>
              <input type="hidden" name="orderId" value={order.id} />
              <input type="hidden" name="status" value="canceled" />
              <ConfirmButton
                label="Cancel"
                confirmLabel="Confirm cancel"
                className={`${smallButtonClass} h-9 px-3 text-sm`}
                confirmClassName="inline-flex h-9 items-center rounded-md border border-error px-3 text-sm font-medium text-error transition-opacity hover:opacity-85"
              />
            </form>
          ) : null}
          {next ? (
            <form action={updateOrderStatus}>
              <input type="hidden" name="orderId" value={order.id} />
              <input type="hidden" name="status" value={next.status} />
              <button
                type="submit"
                className="inline-flex h-9 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85"
              >
                {next.label}
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </article>
  );
}
