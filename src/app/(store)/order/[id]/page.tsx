import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, orderItems, orders } from "@/db";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings-server";
import { formatStoreTime } from "@/lib/store-time";
import { dueCents, paymentState, type KitchenStatus } from "@/lib/orders";
import { OrderAutoRefresh } from "@/components/store/order-auto-refresh";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Order status" };
export const dynamic = "force-dynamic";

const PROGRESS_STEPS = ["new", "preparing", "ready"] as const;

const STATUS_LABELS: Record<KitchenStatus, { title: string; blurb: string }> = {
  held: {
    title: "Scheduled",
    blurb: "We'll start making it closer to your time.",
  },
  new: {
    title: "Order received",
    blurb: "We've got your order and sent it to the kitchen.",
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

  const stepIndex =
    order.status === "completed"
      ? PROGRESS_STEPS.length
      : PROGRESS_STEPS.indexOf(order.status as (typeof PROGRESS_STEPS)[number]);
  const active = order.status !== "completed" && order.status !== "canceled";
  const label = STATUS_LABELS[order.status];
  const payment = paymentState(order);
  const pickupOrDelivery = order.orderType === "delivery" ? "delivery" : "pickup";
  const readyBy = order.promisedAt
    ? formatStoreTime(order.promisedAt, settings.timezone)
    : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      {active ? <OrderAutoRefresh /> : null}

      <p className="text-sm text-muted-foreground">
        Order <span className="font-mono">#{order.orderNumber}</span> ·{" "}
        {order.orderType === "delivery" ? "Delivery" : order.orderType === "dine_in" ? "Dine-in" : "Pickup"}
      </p>
      <h1 className="mt-1 text-2xl font-bold tracking-tight">{label.title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {label.blurb}
        {readyBy && (order.status === "held" || order.status === "new" || order.status === "preparing")
          ? ` Estimated ready by ${readyBy}.`
          : ""}
      </p>

      {order.status !== "canceled" ? (
        <ol className="mt-6 flex items-center gap-1.5" aria-label="Order progress">
          {PROGRESS_STEPS.map((step, i) => (
            <li
              key={step}
              className={cn(
                "h-1.5 flex-1 rounded-full",
                i <= stepIndex ? "bg-foreground" : "bg-border",
              )}
              title={STATUS_LABELS[step].title}
            />
          ))}
        </ol>
      ) : null}

      {order.orderType === "pickup" && settings.addressLine1 ? (
        <Card className="mt-6">
          <CardContent className="text-sm">
            <p className="font-medium">Pickup at</p>
            <p className="mt-1 text-muted-foreground">
              {settings.name} · {settings.addressLine1}
              {settings.addressLine2 ? `, ${settings.addressLine2}` : ""},{" "}
              {settings.city} {settings.zip}
            </p>
            {settings.phone ? (
              <p className="mt-1 text-muted-foreground">{settings.phone}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-8">
        <CardHeader className="border-b">
          <CardTitle className="text-sm font-semibold">Order details</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {items.filter((item) => item.voidedAt === null).map((item) => (
              <li
                key={item.id}
                className="flex justify-between gap-3 py-3 text-sm first:pt-0"
              >
                <div className="min-w-0">
                  <p>
                    <span className="tabular-nums text-muted-foreground">
                      {item.quantity}×
                    </span>{" "}
                    <span className="font-medium">{item.itemName}</span>
                  </p>
                  {item.modifiers.length > 0 ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {item.modifiers
                        .map((m) =>
                          m.kind === "placed" && m.placement !== "whole"
                            ? `${m.modifierName} (${m.placement} half)`
                            : m.modifierName,
                        )
                        .join(" · ")}
                    </p>
                  ) : null}
                  {item.notes ? (
                    <p className="mt-0.5 text-xs italic text-muted-foreground">
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
        </CardContent>
        <CardFooter>
          <dl className="w-full space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="tabular-nums">{formatCents(order.subtotalCents)}</dd>
            </div>
            {order.discountCents > 0 ? (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Discounts</dt>
                <dd className="tabular-nums">−{formatCents(order.discountCents)}</dd>
              </div>
            ) : null}
            {order.taxCents > 0 ? (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Tax</dt>
                <dd className="tabular-nums">{formatCents(order.taxCents)}</dd>
              </div>
            ) : null}
            {order.deliveryFeeCents > 0 ? (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Delivery fee</dt>
                <dd className="tabular-nums">
                  {formatCents(order.deliveryFeeCents)}
                </dd>
              </div>
            ) : null}
            {order.tipCents > 0 ? (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Tip</dt>
                <dd className="tabular-nums">{formatCents(order.tipCents)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatCents(order.totalCents)}</dd>
            </div>
            <div className="flex justify-between pt-1">
              <dt className="text-muted-foreground">Payment</dt>
              <dd className="text-muted-foreground">
                {payment === "paid"
                  ? "Paid"
                  : payment === "refunded"
                    ? "Refunded"
                    : `${formatCents(dueCents(order))} due at ${pickupOrDelivery}`}
              </dd>
            </div>
          </dl>
        </CardFooter>
      </Card>

      <p className="mt-6 text-sm text-muted-foreground">
        Questions about your order?
        {settings.phone ? ` Call us at ${settings.phone}.` : " Call the store."}
      </p>
      <Link
        href="/"
        className={cn(
          buttonVariants({ variant: "outline", size: "lg" }),
          "mt-4 h-10! px-5!",
        )}
      >
        Back to menu
      </Link>
    </div>
  );
}
