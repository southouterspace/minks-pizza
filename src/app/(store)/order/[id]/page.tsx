import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, orderItems, orders } from "@/db";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/orders";
import { OrderAutoRefresh } from "@/components/store/order-auto-refresh";

export const metadata: Metadata = { title: "Order status" };
export const dynamic = "force-dynamic";

const STATUS_STEPS = ["new", "confirmed", "preparing", "ready", "completed"] as const;

const STATUS_LABELS: Record<string, { title: string; blurb: string }> = {
  new: {
    title: "Order received",
    blurb: "We've got your order — the kitchen will confirm it shortly.",
  },
  confirmed: {
    title: "Order confirmed",
    blurb: "The kitchen has confirmed your order.",
  },
  preparing: {
    title: "In the kitchen",
    blurb: "Your food is being made right now.",
  },
  ready: {
    title: "Ready",
    blurb: "Your order is ready!",
  },
  completed: {
    title: "Completed",
    blurb: "Enjoy! Thanks for ordering with us.",
  },
  canceled: {
    title: "Canceled",
    blurb: "This order was canceled. Call us if that's unexpected.",
  },
};

export default async function OrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [order] = await db.select().from(orders).where(eq(orders.id, id));
  if (!order) notFound();

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  const settings = await getSettings();

  const stepIndex = STATUS_STEPS.indexOf(
    order.status as (typeof STATUS_STEPS)[number],
  );
  const active = order.status !== "completed" && order.status !== "canceled";
  const label = STATUS_LABELS[order.status] ?? STATUS_LABELS.new;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      {active ? <OrderAutoRefresh /> : null}

      <p className="text-sm text-muted">
        Order <span className="font-mono">#{order.orderNumber}</span> ·{" "}
        {order.orderType === "pickup" ? "Pickup" : "Delivery"}
      </p>
      <h1 className="mt-1 text-2xl font-bold tracking-tight">{label.title}</h1>
      <p className="mt-2 text-sm text-muted">{label.blurb}</p>

      {order.status !== "canceled" ? (
        <ol className="mt-6 flex items-center gap-1.5" aria-label="Order progress">
          {STATUS_STEPS.slice(0, 4).map((step, i) => (
            <li
              key={step}
              className={`h-1.5 flex-1 rounded-full ${
                i <= stepIndex ? "bg-foreground" : "bg-border"
              }`}
              title={STATUS_LABELS[step].title}
            />
          ))}
        </ol>
      ) : null}

      {order.orderType === "pickup" && settings.addressLine1 ? (
        <div className="mt-6 rounded-lg border border-border p-4 text-sm">
          <p className="font-medium">Pickup at</p>
          <p className="mt-1 text-muted">
            {settings.name} · {settings.addressLine1}
            {settings.addressLine2 ? `, ${settings.addressLine2}` : ""},{" "}
            {settings.city} {settings.zip}
          </p>
          {settings.phone ? (
            <p className="mt-1 text-muted">{settings.phone}</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-8 rounded-lg border border-border">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">
          Order details
        </div>
        <ul className="divide-y divide-border px-4">
          {items.map((item) => (
            <li key={item.id} className="flex justify-between gap-3 py-3 text-sm">
              <div className="min-w-0">
                <p>
                  <span className="tabular-nums text-muted">
                    {item.quantity}×
                  </span>{" "}
                  <span className="font-medium">{item.itemName}</span>
                </p>
                {item.modifiers.length > 0 ? (
                  <p className="mt-0.5 text-xs text-muted">
                    {item.modifiers.map((m) => m.modifierName).join(" · ")}
                  </p>
                ) : null}
                {item.notes ? (
                  <p className="mt-0.5 text-xs italic text-faint">
                    “{item.notes}”
                  </p>
                ) : null}
              </div>
              <span className="shrink-0 tabular-nums">
                {formatCents(item.lineTotalCents)}
              </span>
            </li>
          ))}
        </ul>
        <dl className="space-y-1.5 border-t border-border px-4 py-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Subtotal</dt>
            <dd className="tabular-nums">{formatCents(order.subtotalCents)}</dd>
          </div>
          {order.taxCents > 0 ? (
            <div className="flex justify-between">
              <dt className="text-muted">Tax</dt>
              <dd className="tabular-nums">{formatCents(order.taxCents)}</dd>
            </div>
          ) : null}
          {order.deliveryFeeCents > 0 ? (
            <div className="flex justify-between">
              <dt className="text-muted">Delivery fee</dt>
              <dd className="tabular-nums">
                {formatCents(order.deliveryFeeCents)}
              </dd>
            </div>
          ) : null}
          {order.tipCents > 0 ? (
            <div className="flex justify-between">
              <dt className="text-muted">Tip</dt>
              <dd className="tabular-nums">{formatCents(order.tipCents)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{formatCents(order.totalCents)}</dd>
          </div>
          <div className="flex justify-between pt-1">
            <dt className="text-muted">Payment</dt>
            <dd className="text-muted">
              {order.paymentStatus === "paid"
                ? "Paid online"
                : `Due at ${order.orderType === "pickup" ? "pickup" : "delivery"}`}
            </dd>
          </div>
        </dl>
      </div>

      <p className="mt-6 text-sm text-muted">
        Questions about your order?
        {settings.phone ? ` Call us at ${settings.phone}.` : " Call the store."}
      </p>
      <Link
        href="/"
        className="mt-4 inline-flex h-10 items-center rounded-md border border-border px-5 text-sm font-medium transition-colors hover:border-foreground/40"
      >
        Back to menu
      </Link>
    </div>
  );
}
