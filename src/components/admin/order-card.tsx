import Link from "next/link";
import { History, Wallet } from "lucide-react";
import { formatCents } from "@/lib/money";
import {
  PAYMENT_LABEL,
  channelLabel,
  dueCents,
  fulfillmentLabel,
  modifierLabel,
  orderHistory,
  paymentState,
  type KitchenStatus,
  type OrderView,
  type PaymentState,
} from "@/lib/orders";
import { formatStoreDateTime, formatStoreTime } from "@/lib/store-time";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

export const STATUS_META: Record<
  KitchenStatus,
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

export function StatusBadge({ status }: { status: KitchenStatus }) {
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

function PaymentPill({ order }: { order: OrderView }) {
  const state = paymentState(order.totals);
  const due = dueCents(order.totals);
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

export function OrderCard({ order, tz }: { order: OrderView; tz: string }) {
  const f = order.fulfillment;
  const t = order.totals;
  const due = order.status === "canceled" ? 0 : dueCents(t);
  const history = orderHistory(order);

  return (
    <Card data-testid="order-card" data-order-number={order.number}>
      <CardHeader className="border-b">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold tabular-nums">
            #{order.number}
          </span>
          <StatusBadge status={order.status} />
          <Badge variant="secondary">{channelLabel(order.channel, f.kind)}</Badge>
          <Badge variant="outline" className="text-muted-foreground!">
            {fulfillmentLabel(f)}
          </Badge>
          <PaymentPill order={order} />
        </CardTitle>
        <CardAction className="text-right text-xs text-muted-foreground">
          {formatStoreDateTime(order.placedAt, tz)}
          {order.status === "held" && order.fireAt ? (
            <span className="block">Fires {formatStoreDateTime(order.fireAt, tz)}</span>
          ) : null}
          {order.promisedAt ? (
            <span className="block">Promised {formatStoreDateTime(order.promisedAt, tz)}</span>
          ) : null}
        </CardAction>
      </CardHeader>

      <CardContent>
        <p className="text-sm">
          <span className="font-medium">{order.customer.name}</span>
          {order.customer.phone ? (
            <span className="text-muted-foreground"> · {order.customer.phone}</span>
          ) : null}
        </p>
        {f.kind === "delivery" ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {f.address.line1}
            {f.address.line2 ? `, ${f.address.line2}` : ""}
            {f.address.city ? `, ${f.address.city}` : ""}
            {f.address.zip ? ` ${f.address.zip}` : ""}
          </p>
        ) : null}

        <ul className="mt-3 space-y-2">
          {order.lines.map((line) => (
            <li
              key={line.lineId}
              className={line.voided ? "text-sm text-muted-foreground line-through" : "text-sm"}
            >
              <div className="flex items-baseline justify-between gap-4">
                <span>
                  {line.voided ? (
                    <span className="mr-1 font-semibold text-destructive no-underline">VOID</span>
                  ) : null}
                  <span className="font-medium tabular-nums">{line.quantity} ×</span>{" "}
                  {line.name}
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
                <p className="mt-0.5 text-xs text-muted-foreground">“{line.notes}”</p>
              ) : null}
            </li>
          ))}
        </ul>

        {order.notes ? (
          <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Order note:</span> {order.notes}
          </p>
        ) : null}

        <details data-testid="order-activity" className="group mt-3">
          <summary className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            <History className="size-3.5" aria-hidden="true" />
            Activity ({history.length})
          </summary>
          <ol className="mt-2 space-y-1.5 border-l border-border pl-3">
            {history.map((h, i) => (
              <li key={i} className="text-xs">
                <span className="mr-2 tabular-nums text-muted-foreground">{formatStoreTime(h.at, tz)}</span>
                {h.text}
                {h.who ? <span className="text-muted-foreground"> · {h.who}</span> : null}
                {h.approvedBy && h.approvedBy !== h.who ? (
                  <span className="text-muted-foreground">, approved by {h.approvedBy}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      </CardContent>

      <CardFooter className="flex-wrap items-end justify-between gap-4">
        <dl className="space-y-0.5 text-xs">
          <TotalRow label="Subtotal" value={formatCents(t.subtotalCents)} />
          {t.discountCents > 0 ? (
            <TotalRow label="Discounts" value={`−${formatCents(t.discountCents)}`} />
          ) : null}
          <TotalRow label="Tax" value={formatCents(t.taxCents)} />
          {f.kind === "delivery" || t.deliveryFeeCents > 0 ? (
            <TotalRow label="Delivery fee" value={formatCents(t.deliveryFeeCents)} />
          ) : null}
          {t.tipCents > 0 ? <TotalRow label="Tip" value={formatCents(t.tipCents)} /> : null}
          <TotalRow label="Total" value={formatCents(t.totalCents)} strong />
        </dl>
        {due > 0 ? (
          <Link href={`/pos?order=${order.id}`} className={buttonVariants({ size: "sm" })}>
            <Wallet aria-hidden="true" />
            Collect {formatCents(due)} at POS
          </Link>
        ) : null}
      </CardFooter>
    </Card>
  );
}
