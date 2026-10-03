import { formatClock } from "@/lib/hours";
import { formatCents } from "@/lib/money";
import { PAYMENT_METHOD_LABEL } from "@/lib/order-workflow";
import type { OrderDetail } from "@/lib/order-queries";
import { formatDateTime } from "./ui";

export function addressLine(o: OrderDetail): string | null {
  if (o.orderType !== "delivery" || !o.addressLine1) return null;
  return [o.addressLine1, o.addressLine2, [o.city, o.zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
}

export function Totals({ order, className }: { order: OrderDetail; className?: string }) {
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
export function PrintTicket({ order, timeZone }: { order: OrderDetail; timeZone: string }) {
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
