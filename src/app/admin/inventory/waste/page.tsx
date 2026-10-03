import type { Metadata } from "next";
import Link from "next/link";
import { requireOperator } from "@/lib/auth";
import { recentWaste, stockLines } from "@/lib/inventory";
import { WASTE_REASON_LABEL } from "@/lib/inventory-domain";
import { formatCents } from "@/lib/money";
import { getStoreTimezone } from "@/lib/order-queries";
import { formatQty } from "@/lib/units";
import { formatDateTime } from "@/components/admin/ui";
import { Card } from "@/components/ui/card";
import { toEntry } from "@/app/admin/inventory/entry";
import { WasteForm } from "./waste-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Waste" };

export default async function WastePage() {
  await requireOperator();
  const [lines, waste, timezone] = await Promise.all([stockLines(), recentWaste(), getStoreTimezone()]);
  const total = waste.reduce((sum, w) => sum + w.valueCents, 0);

  return (
    <div>
      <Link href="/admin/inventory" className="text-sm text-muted-foreground hover:text-foreground">
        ← Inventory
      </Link>
      <h1 className="mt-2 text-xl font-semibold tracking-tight">Log waste</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Anything that leaves the kitchen without being sold: dropped, burnt, expired or remade.
      </p>

      <Card className="mt-6 p-4!">
        <WasteForm ingredients={lines.map(toEntry)} />
      </Card>

      <div className="mt-8 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Recent waste</h2>
        {waste.length ? (
          <p className="text-sm text-muted-foreground">
            {formatCents(total)} over the last {waste.length} {waste.length === 1 ? "entry" : "entries"}
          </p>
        ) : null}
      </div>
      {waste.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Nothing logged yet.</p>
      ) : (
        <Card className="mt-3 gap-0! py-0!">
          {waste.map((w, i) => (
            <div
              key={w.id}
              data-testid="waste-row"
              className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-sm ${i > 0 ? "border-t border-border" : ""}`}
            >
              <span className="min-w-0 flex-1 font-medium">
                {formatQty(w.qtyMilli, w.baseUnit)} {w.name}
              </span>
              <span className="text-muted-foreground">
                {w.reason ? WASTE_REASON_LABEL[w.reason] : "Waste"} · {formatDateTime(w.createdAt, timezone)}
              </span>
              <span className="w-16 text-right tabular-nums">{formatCents(w.valueCents)}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
