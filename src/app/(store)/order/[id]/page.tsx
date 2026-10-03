import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings-server";
import { formatStoreTime } from "@/lib/store-time";
import {
  dueCents,
  FULFILLMENT_LABEL,
  modifierLabel,
  PAYMENT_LABEL,
  paymentState,
  type Fulfillment,
  type KitchenStatus,
} from "@/lib/orders";
import { getOrderView } from "@/lib/orders-server/views";
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

/** How many progress steps are filled; held and canceled orders fill none. */
const STEPS_DONE: Record<KitchenStatus, number> = {
  held: -1,
  new: 0,
  preparing: 1,
  ready: 2,
  completed: PROGRESS_STEPS.length,
  canceled: -1,
};

const DUE_AT: Record<Fulfillment["kind"], string> = {
  pickup: "due at pickup",
  delivery: "due at delivery",
  dine_in: "due at the table",
};

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

  const [order, settings] = await Promise.all([getOrderView(id), getSettings()]);
  if (!order) notFound();

  const stepIndex = STEPS_DONE[order.status];
  const active = order.status !== "completed" && order.status !== "canceled";
  const label = STATUS_LABELS[order.status];
  const t = order.totals;
  const payment = paymentState(t);
  const readyBy = order.promisedAt
    ? formatStoreTime(order.promisedAt, settings.timezone)
    : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      {active ? <OrderAutoRefresh /> : null}

      <p className="text-sm text-muted-foreground">
        Order <span className="font-mono">#{order.number}</span> ·{" "}
        {FULFILLMENT_LABEL[order.fulfillment.kind]}
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

      {order.fulfillment.kind === "pickup" && settings.addressLine1 ? (
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
            {order.lines.filter((line) => !line.voided).map((line) => (
              <li
                key={line.lineId}
                className="flex justify-between gap-3 py-3 text-sm first:pt-0"
              >
                <div className="min-w-0">
                  <p>
                    <span className="tabular-nums text-muted-foreground">
                      {line.quantity}×
                    </span>{" "}
                    <span className="font-medium">{line.name}</span>
                  </p>
                  {line.modifiers.length > 0 ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {line.modifiers.map(modifierLabel).join(" · ")}
                    </p>
                  ) : null}
                  {line.notes ? (
                    <p className="mt-0.5 text-xs italic text-muted-foreground">
                      “{line.notes}”
                    </p>
                  ) : null}
                </div>
                <span className="shrink-0 tabular-nums">
                  {formatCents(line.lineTotalCents)}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
        <CardFooter>
          <dl className="w-full space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="tabular-nums">{formatCents(t.subtotalCents)}</dd>
            </div>
            {t.discountCents > 0 ? (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Discounts</dt>
                <dd className="tabular-nums">−{formatCents(t.discountCents)}</dd>
              </div>
            ) : null}
            {t.taxCents > 0 ? (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Tax</dt>
                <dd className="tabular-nums">{formatCents(t.taxCents)}</dd>
              </div>
            ) : null}
            {t.deliveryFeeCents > 0 ? (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Delivery fee</dt>
                <dd className="tabular-nums">
                  {formatCents(t.deliveryFeeCents)}
                </dd>
              </div>
            ) : null}
            {t.tipCents > 0 ? (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Tip</dt>
                <dd className="tabular-nums">{formatCents(t.tipCents)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatCents(t.totalCents)}</dd>
            </div>
            <div className="flex justify-between pt-1">
              <dt className="text-muted-foreground">Payment</dt>
              <dd className="text-muted-foreground">
                {payment === "unpaid" || payment === "partial"
                  ? `${formatCents(dueCents(t))} ${DUE_AT[order.fulfillment.kind]}`
                  : PAYMENT_LABEL[payment]}
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
