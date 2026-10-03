import { getCurrentOperator } from "@/lib/auth";
import { exportOrders, parseOrderFilters } from "@/lib/orders-admin";

export const dynamic = "force-dynamic";

/**
 * RFC 4180 field: quoted when it holds a comma, quote or line break. A
 * leading =, +, - or @ gets a ' so spreadsheets don't run it as a formula.
 */
function csvField(value: string | number | null): string {
  if (value === null) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

/** The history view's rows as CSV, same filters, capped at EXPORT_CAP. */
export async function GET(request: Request): Promise<Response> {
  if (!(await getCurrentOperator())) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }
  const filters = parseOrderFilters(new URL(request.url).searchParams);
  const { rows, timezone } = await exportOrders(filters);

  const localTime = (d: Date | null) =>
    d
      ? d.toLocaleString("sv-SE", { timeZone: timezone, hour12: false }).slice(0, 16)
      : null;

  const header = [
    "Order",
    "Placed",
    "Status",
    "Type",
    "Customer",
    "Phone",
    "Email",
    "Subtotal",
    "Tax",
    "Delivery fee",
    "Tip",
    "Total",
    "Payment",
    "Payment method",
    "Promised",
    "Ready",
    "Completed",
    "Canceled",
    "Cancel reason",
  ];
  const lines = [header.map(csvField).join(",")];
  for (const o of rows) {
    lines.push(
      [
        o.orderNumber,
        localTime(o.placedAt),
        o.status,
        o.orderType,
        o.customerName,
        o.customerPhone,
        o.customerEmail,
        dollars(o.subtotalCents),
        dollars(o.taxCents),
        dollars(o.deliveryFeeCents),
        dollars(o.tipCents),
        dollars(o.totalCents),
        o.paymentStatus,
        o.paymentMethod,
        localTime(o.promisedAt),
        localTime(o.readyAt),
        localTime(o.completedAt),
        localTime(o.canceledAt),
        o.cancelReason,
      ]
        .map(csvField)
        .join(","),
    );
  }

  const stamp = new Date().toLocaleDateString("sv-SE", { timeZone: timezone });
  return new Response(`${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orders-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
