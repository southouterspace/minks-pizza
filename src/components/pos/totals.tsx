import { Fragment } from "react";
import type { Totals } from "@/lib/orders";
import { formatCents } from "@/lib/money";

type Charges = Pick<Totals, "subtotalCents" | "taxCents" | "deliveryFeeCents"> & Partial<Pick<Totals, "discountCents" | "tipCents">>;

/** The lines above a check's total, in order; a zero discount, fee or tip is left off. */
export function chargeRows(t: Charges): { label: string; amount: string }[] {
  const rows = [{ label: "Subtotal", amount: formatCents(t.subtotalCents) }];
  if (t.discountCents) rows.push({ label: "Discounts", amount: `−${formatCents(t.discountCents)}` });
  rows.push({ label: "Tax", amount: formatCents(t.taxCents) });
  if (t.deliveryFeeCents) rows.push({ label: "Delivery", amount: formatCents(t.deliveryFeeCents) });
  if (t.tipCents) rows.push({ label: "Tip", amount: formatCents(t.tipCents) });
  return rows;
}

/** `chargeRows` as `<dt>`/`<dd>` pairs for a two-column `<dl>`. */
export function ChargeRows({ totals }: { totals: Charges }) {
  return chargeRows(totals).map((r) => (
    <Fragment key={r.label}>
      <dt className="text-muted-foreground">{r.label}</dt>
      <dd className="text-right">{r.amount}</dd>
    </Fragment>
  ));
}
