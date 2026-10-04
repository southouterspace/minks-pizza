import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, notInArray } from "drizzle-orm";
import { Gift } from "lucide-react";
import { courierDeliveries, db, orderDiscounts, orderItems, orders } from "@/db";
import { COURIER_STATUS_LABEL, TERMINAL_COURIER_STATUSES } from "@/lib/delivery/types";
import { formatClock } from "@/lib/zoned";
import { SIGNUP_MIN_NET_CENTS, normalizePhone, orderPointsStatus } from "@/lib/loyalty";
import { getLoyaltySettings, memberByPhone } from "@/lib/loyalty-server";
import { getCurrentMember } from "@/lib/member-auth";
import { formatCents } from "@/lib/money";
import { dueCents, paymentState } from "@/lib/orders";
import { describeChoice } from "@/lib/pricing";
import { isActive, isCooking } from "@/lib/order-workflow";
import { getSettings } from "@/lib/settings-server";
import { OrderAutoRefresh } from "@/components/store/order-auto-refresh";
import { OrderRewardsJoin } from "@/components/store/order-rewards-join";
import { orderTotals, TotalsList } from "@/components/totals-list";
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

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_STEPS = ["new", "preparing", "ready", "completed"] as const;

const STATUS_LABELS: Record<string, { title: string; blurb: string }> = {
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

  const [items, discounts, settings, [courier], loyalty, viewer] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, order.id)),
    db
      .select()
      .from(orderDiscounts)
      .where(eq(orderDiscounts.orderId, order.id))
      .orderBy(asc(orderDiscounts.id)),
    getSettings(),
    db
      .select()
      .from(courierDeliveries)
      .where(
        and(
          eq(courierDeliveries.orderId, order.id),
          notInArray(courierDeliveries.status, [...TERMINAL_COURIER_STATUSES]),
        ),
      )
      .orderBy(desc(courierDeliveries.createdAt))
      .limit(1),
    getLoyaltySettings(),
    getCurrentMember(),
  ]);

  const stepIndex = STATUS_STEPS.indexOf(
    order.status as (typeof STATUS_STEPS)[number],
  );
  const active = isActive(order.status);
  const label = STATUS_LABELS[order.status] ?? STATUS_LABELS.new;
  const phone = normalizePhone(order.customerPhone);
  const rewardsPrompt =
    loyalty.enabled && viewer === null && phone && claimable(order)
      ? joinPrompt(order, loyalty, {
          phoneLast4: phone.slice(-4),
          isMember: order.loyaltyMemberId !== null || (await memberByPhone(phone)) !== null,
        })
      : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      {active ? <OrderAutoRefresh /> : null}

      <p className="text-sm text-muted-foreground">
        Order <span className="font-mono">#{order.orderNumber}</span> ·{" "}
        {order.orderType === "pickup" ? "Pickup" : "Delivery"}
      </p>
      <h1 className="mt-1 text-2xl font-bold tracking-tight">{label.title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{label.blurb}</p>
      {order.status === "canceled" && order.cancelReason ? (
        <p className="mt-2 text-sm" data-testid="cancel-reason">
          Reason: {order.cancelReason}
        </p>
      ) : null}
      {isCooking(order.status) && order.promisedAt ? (
        <p className="mt-3 text-sm font-medium" data-testid="ready-around">
          Ready around {formatClock(order.promisedAt, settings.timezone)}
        </p>
      ) : null}

      {order.status !== "canceled" ? (
        <ol className="mt-6 flex items-center gap-1.5" aria-label="Order progress">
          {STATUS_STEPS.slice(0, 4).map((step, i) => (
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

      {courier ? (
        <Card className="mt-6">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div>
              <p className="font-medium">{COURIER_STATUS_LABEL[courier.status]}</p>
              {courier.courierName ? (
                <p className="mt-1 text-muted-foreground">
                  Your driver is {courier.courierName}.
                </p>
              ) : null}
            </div>
            {courier.trackingUrl ? (
              <a
                href={courier.trackingUrl}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: "outline" })}
              >
                Track your driver
              </a>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {rewardsPrompt ? (
        <OrderRewardsJoin orderId={order.id} {...rewardsPrompt} />
      ) : order.loyaltyMemberId !== null && order.loyaltyPointsEarned > 0 && orderPointsStatus(order.status) !== "Reversed" ? (
        <p
          data-testid="order-points"
          className="mt-6 flex items-center gap-2 rounded-lg bg-muted px-4 py-3 text-sm"
        >
          <Gift className="size-4 shrink-0" aria-hidden />
          {orderPointsStatus(order.status) === "Posted"
            ? `You earned ${order.loyaltyPointsEarned.toLocaleString()} points.`
            : `You'll earn ${order.loyaltyPointsEarned.toLocaleString()} points once your order is complete.`}
          <Link href="/rewards" className="ml-auto font-medium underline underline-offset-4">
            Rewards
          </Link>
        </p>
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
            {items.map((item) => (
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
                      {item.modifiers.map((m) => (m.kind === "option" ? `${m.groupName}: ${describeChoice(m)}` : describeChoice(m))).join(" · ")}
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
        <CardFooter className="flex-col items-stretch gap-1.5">
          <TotalsList totals={orderTotals({ ...order, discounts })} audience="customer" />
          <p className="flex justify-between text-sm text-muted-foreground">
            <span>Payment</span>
            <span>
              {paymentState(order) === "paid"
                ? "Paid"
                : `${formatCents(dueCents(order))} due at ${order.orderType === "pickup" ? "pickup" : "delivery"}`}
            </span>
          </p>
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

/** Signing in links only the last 30 days of uncanceled orders (claimRecentOrders). */
function claimable(order: typeof orders.$inferSelect): boolean {
  return order.status !== "canceled" && Date.now() - order.placedAt.getTime() < 30 * DAY_MS;
}

/**
 * What the order page asks a signed-out customer: to join and keep this
 * order's points, or, when they joined at checkout, to verify the phone so
 * they can see and spend them.
 */
function joinPrompt(
  order: typeof orders.$inferSelect,
  loyalty: { programName: string; signupBonus: number },
  { phoneLast4, isMember }: { phoneLast4: string; isMember: boolean },
) {
  const points = order.loyaltyPointsEarned;
  const pointsText = `${points.toLocaleString()} points`;
  if (order.loyaltyMemberId !== null) {
    return {
      phoneLast4,
      title:
        points === 0
          ? `You're in ${loyalty.programName}`
          : order.status === "completed"
            ? `You earned ${pointsText}`
            : `You're earning ${pointsText} on this order`,
      body: "Confirm your number to see your balance, track rewards, and spend points next time.",
      action: "Confirm my number",
    };
  }
  if (isMember) {
    return {
      phoneLast4,
      title: points > 0 ? `Add ${pointsText} to your ${loyalty.programName} account` : `Sign in to ${loyalty.programName}`,
      body: "This number is already a member. Sign in and this order counts toward your rewards.",
      action: points > 0 ? "Add my points" : "Sign in",
    };
  }
  const bonus =
    loyalty.signupBonus > 0 && order.subtotalCents - order.discountCents >= SIGNUP_MIN_NET_CENTS
      ? ` Join now and get ${loyalty.signupBonus.toLocaleString()} bonus points too.`
      : "";
  return {
    phoneLast4,
    title: points > 0 ? `Keep the ${pointsText} from this order` : `Join ${loyalty.programName}`,
    body: `${loyalty.programName} is free. Points turn into free food.${bonus}`,
    action: points > 0 ? "Save my points" : "Join free",
  };
}
