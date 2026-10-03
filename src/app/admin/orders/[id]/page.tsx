import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Phone } from "lucide-react";
import type { orderEvents } from "@/db";
import {
  addOrderNoteAction,
  adjustPromisedTimeAction,
  moveOrder,
  recordPaymentAction,
} from "@/app/admin/actions";
import { requireOperator } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import {
  ACTIVE_STATUSES,
  canTransition,
  isLate,
  NEXT_ACTION,
  PAYMENT_METHOD_LABEL,
  PAYMENT_METHODS,
  STATUS_META,
} from "@/lib/order-workflow";
import { getOrderDetail, getStoreTimezone } from "@/lib/orders-admin";
import { PromisedTime } from "@/components/admin/board-card";
import {
  ActionForm,
  CancelOrderDialog,
  PrintButton,
  SubmitButton,
} from "@/components/admin/order-actions";
import { LateBadge, PaymentBadge, StatusBadge } from "@/components/admin/order-status";
import { formatClock, formatDateTime } from "@/components/admin/ui";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Order" };

type OrderEvent = typeof orderEvents.$inferSelect;
type TimelineEntry = Pick<
  OrderEvent,
  "type" | "fromStatus" | "toStatus" | "actor" | "note" | "createdAt"
> & { key: string | number };
type Detail = NonNullable<Awaited<ReturnType<typeof getOrderDetail>>>;

function describeEvent(e: TimelineEntry): string {
  switch (e.type) {
    case "placed":
      return "Order placed";
    case "status_changed":
      if (e.toStatus === "canceled") return "Canceled";
      if (e.fromStatus && e.toStatus === "preparing" && ["ready", "completed"].includes(e.fromStatus)) {
        return "Recalled to the kitchen";
      }
      return e.toStatus ? STATUS_META[e.toStatus].label : "Status changed";
    case "eta_changed":
      return "Promised time pushed";
    case "payment_recorded":
      return "Payment recorded";
    case "note_added":
      return "Note";
  }
}

function addressLine(o: Detail): string | null {
  if (o.orderType !== "delivery" || !o.addressLine1) return null;
  return [o.addressLine1, o.addressLine2, [o.city, o.zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
}

function Totals({ order, className }: { order: Detail; className?: string }) {
  const rows: [string, number][] = [
    ["Subtotal", order.subtotalCents],
    ["Tax", order.taxCents],
    ...(order.deliveryFeeCents > 0 ? [["Delivery fee", order.deliveryFeeCents] as [string, number]] : []),
    ...(order.tipCents > 0 ? [["Tip", order.tipCents] as [string, number]] : []),
  ];
  return (
    <dl className={className}>
      {rows.map(([label, cents]) => (
        <div key={label} className="flex justify-between gap-6">
          <dt className="text-muted-foreground print:text-black">{label}</dt>
          <dd className="tabular-nums">{formatCents(cents)}</dd>
        </div>
      ))}
      <div className="flex justify-between gap-6 border-t pt-1.5 font-semibold">
        <dt>Total</dt>
        <dd className="tabular-nums">{formatCents(order.totalCents)}</dd>
      </div>
    </dl>
  );
}

/** Receipt-width kitchen/counter ticket, the only thing on the page when printing. */
function PrintTicket({ order, timeZone }: { order: Detail; timeZone: string }) {
  const address = addressLine(order);
  return (
    <div className="hidden font-mono text-[12px] leading-snug text-black print:block print:w-[72mm]">
      <style>{"@page { size: 80mm auto; margin: 4mm; }"}</style>
      <p className="text-center text-lg font-bold">#{order.orderNumber}</p>
      <p className="text-center font-bold uppercase">
        {order.orderType === "delivery" ? "Delivery" : "Pickup"}
      </p>
      <p className="mt-1 text-center">
        Placed {formatDateTime(order.placedAt, timeZone)}
        {order.promisedAt ? ` · Ready ${formatClock(order.promisedAt, timeZone)}` : ""}
      </p>
      <hr className="my-2 border-dashed border-black" />
      <p className="font-bold">{order.customerName}</p>
      <p>{order.customerPhone}</p>
      {address ? <p>{address}</p> : null}
      <hr className="my-2 border-dashed border-black" />
      {order.items.map((line) => (
        <div key={line.id} className="mb-1.5">
          <p className="flex justify-between gap-2 font-bold">
            <span>
              {line.quantity} × {line.itemName}
            </span>
            <span>{formatCents(line.lineTotalCents)}</span>
          </p>
          {line.modifiers.map((m) => (
            <p key={`${m.groupName}-${m.modifierName}`} className="pl-3">
              {m.modifierName}
            </p>
          ))}
          {line.notes ? <p className="pl-3 italic">* {line.notes}</p> : null}
        </div>
      ))}
      {order.orderNotes ? (
        <p className="my-2 border border-black p-1 font-bold">NOTE: {order.orderNotes}</p>
      ) : null}
      <hr className="my-2 border-dashed border-black" />
      <Totals order={order} />
      <p className="mt-2 text-center font-bold uppercase">
        {order.paymentStatus === "paid"
          ? `Paid${order.paymentMethod ? ` · ${PAYMENT_METHOD_LABEL[order.paymentMethod]}` : ""}`
          : "Payment due"}
      </p>
    </div>
  );
}

export default async function OrderDetailPage({ params }: PageProps<"/admin/orders/[id]">) {
  await requireOperator();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [order, timeZone] = await Promise.all([getOrderDetail(id), getStoreTimezone()]);
  if (!order) notFound();

  const now = new Date();
  const next = NEXT_ACTION[order.status];
  const late = isLate(order.promisedAt, order.status, now);
  const active = (ACTIVE_STATUSES as readonly string[]).includes(order.status);
  const address = addressLine(order);
  // Orders from before the audit trail have no "placed" row; show one anyway.
  const timeline: TimelineEntry[] = order.events.some((e) => e.type === "placed")
    ? order.events.map((e) => ({ ...e, key: e.id }))
    : [
        {
          key: "placed",
          type: "placed",
          fromStatus: null,
          toStatus: "new",
          actor: "Customer",
          note: null,
          createdAt: order.placedAt,
        },
        ...order.events.map((e) => ({ ...e, key: e.id })),
      ];

  return (
    <div className="print:m-0">
      <PrintTicket order={order} timeZone={timeZone} />

      <div className="print:hidden">
        <Link
          href="/admin/orders"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          History
        </Link>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
              <span className="tabular-nums">Order #{order.orderNumber}</span>
              <StatusBadge status={order.status} />
              <Badge variant="outline" className="text-muted-foreground!">
                {order.orderType === "delivery" ? "Delivery" : "Pickup"}
              </Badge>
              <PaymentBadge status={order.paymentStatus} method={order.paymentMethod} />
              {late ? <LateBadge /> : null}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Placed {formatDateTime(order.placedAt, timeZone)}
            </p>
          </div>
          <PrintButton />
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-4">
            <Card size="sm">
              <CardHeader>
                <CardTitle>Customer</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                <p className="font-medium">{order.customerName}</p>
                <a
                  href={`tel:${order.customerPhone.replace(/[^\d+]/g, "")}`}
                  className="inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline"
                >
                  <Phone className="size-3.5" />
                  {order.customerPhone}
                </a>
                {order.customerEmail ? (
                  <p className="text-muted-foreground">{order.customerEmail}</p>
                ) : null}
                {address ? <p className="text-muted-foreground">{address}</p> : null}
              </CardContent>
            </Card>

            <Card size="sm">
              <CardHeader>
                <CardTitle>Items</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {order.items.map((line) => (
                    <li key={line.id} className="py-2 first:pt-0">
                      <div className="flex items-baseline justify-between gap-4">
                        <span>
                          <span className="font-medium tabular-nums">{line.quantity} ×</span>{" "}
                          {line.itemName}
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatCents(line.lineTotalCents)}
                        </span>
                      </div>
                      {line.modifiers.length > 0 ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {line.modifiers.map((m) => `${m.groupName}: ${m.modifierName}`).join(" · ")}
                        </p>
                      ) : null}
                      {line.notes ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">“{line.notes}”</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {order.orderNotes ? (
                  <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Order note:</span>{" "}
                    {order.orderNotes}
                  </p>
                ) : null}
                <Separator className="my-3" />
                <Totals order={order} className="ml-auto max-w-56 space-y-1 text-sm" />
              </CardContent>
            </Card>

            <Card size="sm">
              <CardHeader>
                <CardTitle>Timeline</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="relative space-y-3 border-l pl-4" data-testid="timeline">
                  {timeline.map((e) => (
                    <li key={e.key} className="relative">
                      <span
                        className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-foreground/30"
                        aria-hidden="true"
                      />
                      <p className="text-sm">
                        <span className="font-medium">{describeEvent(e)}</span>
                        {e.note ? <span className="text-muted-foreground"> · {e.note}</span> : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {e.actor} · {formatDateTime(e.createdAt, timeZone)}
                      </p>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4 max-lg:order-first">
            <Card size="sm">
              <CardHeader>
                <CardTitle>Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {next || canTransition(order.status, "canceled") ? (
                  <div className="flex flex-wrap gap-2">
                    {next ? (
                      <ActionForm action={moveOrder} orderId={order.id}>
                        <input type="hidden" name="to" value={next.to} />
                        <SubmitButton data-testid="detail-advance">{next.label}</SubmitButton>
                      </ActionForm>
                    ) : null}
                    {canTransition(order.status, "canceled") ? (
                      <CancelOrderDialog
                        orderId={order.id}
                        orderNumber={order.orderNumber}
                        size="default"
                      />
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {order.status === "canceled"
                      ? `Canceled${order.cancelReason ? `: ${order.cancelReason}` : ""}.`
                      : "This order is complete."}
                  </p>
                )}

                {active ? (
                  <div className="space-y-2">
                    <p className="text-sm">
                      <PromisedTime
                        promisedAt={order.promisedAt}
                        late={late}
                        now={now}
                        timeZone={timeZone}
                      />
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {[-5, 5, 10, 15].map((m) => (
                        <ActionForm key={m} action={adjustPromisedTimeAction} orderId={order.id}>
                          <input type="hidden" name="minutes" value={m} />
                          <SubmitButton
                            variant="outline"
                            size="sm"
                            className="tabular-nums"
                            data-testid={`detail-eta-${m}`}
                          >
                            {m > 0 ? `+${m}` : `−${-m}`} min
                          </SubmitButton>
                        </ActionForm>
                      ))}
                    </div>
                  </div>
                ) : null}

                {order.paymentStatus === "pending" ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Record payment</p>
                    <div className="flex flex-wrap gap-1.5">
                      {PAYMENT_METHODS.map((method) => (
                        <ActionForm key={method} action={recordPaymentAction} orderId={order.id}>
                          <input type="hidden" name="method" value={method} />
                          <SubmitButton
                            variant="outline"
                            size="sm"
                            data-testid={`pay-${method}`}
                          >
                            {PAYMENT_METHOD_LABEL[method]}
                          </SubmitButton>
                        </ActionForm>
                      ))}
                    </div>
                  </div>
                ) : null}

                <ActionForm action={addOrderNoteAction} orderId={order.id} className="space-y-2">
                  <label htmlFor="order-note" className="text-sm font-medium">
                    Internal note
                  </label>
                  <Textarea
                    id="order-note"
                    name="note"
                    rows={2}
                    maxLength={500}
                    placeholder="Only staff see this"
                    required
                  />
                  <SubmitButton variant="outline" size="sm" data-testid="add-note">
                    Add note
                  </SubmitButton>
                </ActionForm>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
