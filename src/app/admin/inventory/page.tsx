import type { Metadata } from "next";
import Link from "next/link";
import { ClipboardList, PackageOpen, ScanSearch, Settings2, Trash2 } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import { stockLines, type StockStatus } from "@/lib/inventory";
import { milliToCents } from "@/lib/inventory-domain";
import { formatCents } from "@/lib/money";
import { formatQty } from "@/lib/units";
import { byArea } from "@/app/admin/inventory/entry";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Inventory" };

const STATUS_BADGE: Record<StockStatus, { label: string; className: string } | null> = {
  out: { label: "Out", className: "border-destructive/40 bg-destructive/10 text-destructive" },
  low: { label: "Low", className: "border-warning/40 bg-warning/10 text-warning" },
  uncounted: { label: "Not counted yet", className: "text-muted-foreground" },
  ok: null,
};

const ACTIONS = [
  { href: "/admin/inventory/count?kind=full", label: "Full count", icon: ClipboardList, variant: "default" },
  { href: "/admin/inventory/count?kind=spot", label: "Spot count", icon: ScanSearch, variant: "outline" },
  { href: "/admin/inventory/waste", label: "Log waste", icon: Trash2, variant: "outline" },
  { href: "/admin/inventory/receive", label: "Receive delivery", icon: PackageOpen, variant: "outline" },
  { href: "/admin/inventory/ingredients", label: "Ingredients", icon: Settings2, variant: "outline" },
] as const;

export default async function InventoryPage({ searchParams }: PageProps<"/admin/inventory">) {
  await requireOperator();
  const [lines, { notice }] = await Promise.all([stockLines(), searchParams]);
  const value = (l: (typeof lines)[number]) => milliToCents(l.onHandMilli, l.unitCostMillicents);
  const total = lines.reduce((sum, l) => sum + value(l), 0);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Inventory</h1>
        <p className="text-sm text-muted-foreground">
          On hand{" "}
          <span className="font-medium text-foreground tabular-nums" data-testid="stock-total">
            {formatCents(total)}
          </span>
        </p>
      </div>
      {notice === "counted" ? (
        <p role="status" className="mt-2 text-sm font-medium text-success">
          Count saved. On hand now matches the shelves.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {ACTIONS.map(({ href, label, icon: Icon, variant }) => (
          <Link key={href} href={href} className={buttonVariants({ variant, size: "sm" })}>
            <Icon aria-hidden="true" />
            {label}
          </Link>
        ))}
      </div>

      <div className="mt-6 space-y-6">
        {byArea(lines).map(({ area, rows }) => (
          <section key={area}>
            <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {area}
            </h2>
            <Card className="gap-0! py-0!">
              {rows.map((l, i) => {
                const badge = STATUS_BADGE[l.status];
                return (
                  <div
                    key={l.id}
                    data-testid={`stock-row-${l.id}`}
                    className={`flex items-center gap-3 px-4 py-3 text-sm ${i > 0 ? "border-t border-border" : ""}`}
                  >
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium">{l.name}</span>
                      {badge ? (
                        <Badge variant="outline" className={badge.className}>
                          {badge.label}
                        </Badge>
                      ) : null}
                    </div>
                    <span className="w-16 shrink-0 text-right tabular-nums sm:w-20">
                      {formatQty(l.onHandMilli, l.baseUnit)}
                    </span>
                    <span className="w-16 shrink-0 text-right text-muted-foreground tabular-nums sm:w-20">
                      {formatCents(value(l))}
                    </span>
                  </div>
                );
              })}
            </Card>
          </section>
        ))}
      </div>
    </div>
  );
}
