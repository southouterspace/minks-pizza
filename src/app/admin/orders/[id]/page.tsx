import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Phone } from "lucide-react";
import { addOrderNoteAction, recordPaymentAction } from "@/app/admin/actions";
import { requireOperator } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import {
  canTransition,
  isCooking,
  isLate,
  NEXT_ACTION,
  PAYMENT_METHOD_LABEL,
  PAYMENT_METHODS,
} from "@/lib/order-workflow";
import { getOrderDetail, getStoreTimezone } from "@/lib/order-queries";
import {
  ActionForm,
  AdvanceButton,
  CancelOrderDialog,
  EtaButtons,
  PrintButton,
  SubmitButton,
} from "@/components/admin/order-actions";
import {
  LateBadge,
  PaymentBadge,
  PromisedTime,
  StatusBadge,
} from "@/components/admin/order-status";
import { addressLine, PrintTicket, Totals } from "@/components/admin/order-ticket";
import { OrderTimeline } from "@/components/admin/order-timeline";
import { formatDateTime } from "@/components/admin/ui";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Order" };

export default async function OrderDetailPage({ params }: PageProps<"/admin/orders/[id]">) {
  await requireOperator();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [order, timeZone] = await Promise.all([getOrderDetail(id), getStoreTimezone()]);
  if (!order) notFound();

  const now = new Date();
  const late = isLate(order.promisedAt, order.status, now);
  const address = addressLine(order);
  const open = NEXT_ACTION[order.status] || canTransition(order.status, "canceled");

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

            <OrderTimeline order={order} timeZone={timeZone} />
          </div>

          <div className="space-y-4 max-lg:order-first">
            <Card size="sm">
              <CardHeader>
                <CardTitle>Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {open ? (
                  <div className="flex flex-wrap gap-2">
                    <AdvanceButton
                      orderId={order.id}
                      status={order.status}
                      size="default"
                      testId="detail-advance"
                    />
                    <CancelOrderDialog
                      orderId={order.id}
                      orderNumber={order.orderNumber}
                      status={order.status}
                      size="default"
                    />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {order.status === "canceled"
                      ? `Canceled${order.cancelReason ? `: ${order.cancelReason}` : ""}.`
                      : "This order is complete."}
                  </p>
                )}

                {isCooking(order.status) ? (
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
                      <EtaButtons
                        orderId={order.id}
                        orderNumber={order.orderNumber}
                        status={order.status}
                        minutes={[-5, 5, 10, 15]}
                      />
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
