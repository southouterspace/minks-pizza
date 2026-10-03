import { paymentState } from "@/lib/orders";
import { getCurrentOperator } from "@/lib/auth";
import { csvResponse } from "@/lib/csv";
import { exportOrders, parseOrderFilters } from "@/lib/order-queries";

export const dynamic = "force-dynamic";

const dollars = (cents: number) => (cents / 100).toFixed(2);

type Row = Awaited<ReturnType<typeof exportOrders>>["rows"][number];
type Column = [
  header: string,
  value: (
    o: Row,
    localTime: (d: Date | null) => string | null,
  ) => string | number | null,
];

const COLUMNS: Column[] = [
  ["Order", (o) => o.orderNumber],
  ["Placed", (o, t) => t(o.placedAt)],
  ["Status", (o) => o.status],
  ["Type", (o) => o.orderType],
  ["Customer", (o) => o.customerName],
  ["Phone", (o) => o.customerPhone],
  ["Email", (o) => o.customerEmail],
  ["Subtotal", (o) => dollars(o.subtotalCents)],
  ["Discount", (o) => dollars(o.discountCents)],
  ["Discounts", (o) => o.discountLabels],
  ["Tax", (o) => dollars(o.taxCents)],
  ["Delivery fee", (o) => dollars(o.deliveryFeeCents)],
  ["Tip", (o) => dollars(o.tipCents)],
  ["Total", (o) => dollars(o.totalCents)],
  ["Payment", (o) => paymentState(o)],
  ["Paid", (o) => dollars(o.paidCents)],
  ["Refunded", (o) => dollars(o.refundedCents)],
  ["Promised", (o, t) => t(o.promisedAt)],
  ["Ready", (o, t) => t(o.readyAt)],
  ["Completed", (o, t) => t(o.completedAt)],
  ["Canceled", (o, t) => t(o.canceledAt)],
  ["Cancel reason", (o) => o.cancelReason],
];

/** The history view's rows as CSV, same filters, capped at EXPORT_CAP. */
export async function GET(request: Request): Promise<Response> {
  if (!(await getCurrentOperator())) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }
  const filters = parseOrderFilters(new URL(request.url).searchParams);
  const { rows, timezone } = await exportOrders(filters);

  const localTime = (d: Date | null) =>
    d
      ? d
          .toLocaleString("sv-SE", { timeZone: timezone, hour12: false })
          .slice(0, 16)
      : null;

  const stamp = new Date().toLocaleDateString("sv-SE", { timeZone: timezone });
  return csvResponse(
    `orders-${stamp}.csv`,
    COLUMNS.map(([header]) => header),
    rows.map((o) => COLUMNS.map(([, value]) => value(o, localTime))),
  );
}
