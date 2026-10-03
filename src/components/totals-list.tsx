import type { ReactNode } from "react";
import { Tag } from "lucide-react";
import { formatCents } from "@/lib/money";
import type { DiscountSource } from "@/lib/promotion-schema";
import { cn } from "@/lib/utils";

export type TotalsDiscount = {
  key: string | number;
  label: string;
  amountCents: number;
  /** A line under the label, such as the code or "Applied automatically". */
  detail?: ReactNode;
  /** A control beside the amount, such as removing the code. */
  action?: ReactNode;
};

/** The money block every surface shows, as plain data. */
export type Totals = {
  subtotalCents: number;
  discounts: TotalsDiscount[];
  deliveryFeeCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  discountCents: number;
};

/** A placed order's totals. */
export function orderTotals(o: {
  subtotalCents: number;
  deliveryFeeCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  discountCents: number;
  /** A loyalty discount's points read from the order; one reward per order. */
  loyaltyPointsRedeemed?: number;
  discounts: { id: number; label: string; amountCents: number; source: DiscountSource }[];
}): Totals {
  const points = o.loyaltyPointsRedeemed ?? 0;
  return {
    ...o,
    discounts: o.discounts.map((d) => ({
      key: d.id,
      label: d.label,
      amountCents: d.amountCents,
      detail: d.source === "loyalty" && points > 0 ? `Reward · ${points.toLocaleString()} points` : undefined,
    })),
  };
}

/**
 * Subtotal, each discount on its own line, delivery fee, tax, tip, then the
 * total; zero fees, tax and tip are left out. `children` sit just above the
 * total (the cart's nudges). Customers also read what they save.
 */
export function TotalsList({
  totals,
  audience,
  totalLabel = "Total",
  saved = "saved",
  className,
  children,
}: {
  totals: Totals;
  audience: "customer" | "staff";
  totalLabel?: string;
  saved?: "save" | "saved";
  className?: string;
  children?: ReactNode;
}) {
  const customer = audience === "customer";
  return (
    <dl className={cn("space-y-1.5", customer && "text-sm", className)}>
      <Row label="Subtotal" cents={totals.subtotalCents} />
      {totals.discounts.map((d) => (
        <div key={d.key} className="flex justify-between gap-3 text-success print:text-black" data-testid="discount-line">
          <dt className="min-w-0">
            <span className="flex items-center gap-1.5 font-medium">
              <Tag className="size-3.5 shrink-0 print:hidden" aria-hidden />
              <span className="truncate">{d.label}</span>
            </span>
            {d.detail ? <span className="block text-xs text-muted-foreground">{d.detail}</span> : null}
          </dt>
          <dd className="flex shrink-0 items-start gap-1 tabular-nums">
            −{formatCents(d.amountCents)}
            {d.action}
          </dd>
        </div>
      ))}
      {totals.deliveryFeeCents > 0 ? <Row label="Delivery fee" cents={totals.deliveryFeeCents} /> : null}
      {totals.taxCents > 0 ? <Row label="Tax" cents={totals.taxCents} /> : null}
      {totals.tipCents > 0 ? <Row label="Tip" cents={totals.tipCents} /> : null}
      {children}
      <div className={cn("flex justify-between gap-3 border-t border-border pt-2 font-semibold", customer && "text-base")}>
        <dt>{totalLabel}</dt>
        <dd className="tabular-nums" data-testid="totals-total">
          {formatCents(totals.totalCents)}
        </dd>
      </div>
      {customer && totals.discountCents > 0 ? (
        <p className="text-right text-xs font-medium text-success" data-testid="you-saved">
          You {saved} {formatCents(totals.discountCents)}
        </p>
      ) : null}
    </dl>
  );
}

function Row({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground print:text-black">{label}</dt>
      <dd className="tabular-nums">{formatCents(cents)}</dd>
    </div>
  );
}
