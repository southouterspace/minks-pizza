import Link from "next/link";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { inventoryAlerts } from "@/lib/inventory";
import { formatQty } from "@/lib/units";

/** Red line per stock-out, one amber line for everything running low; nothing when all is well. */
export async function InventoryBanner() {
  const { out, low } = await inventoryAlerts();
  if (out.length === 0 && low.length === 0) return null;
  return (
    <div className="print:hidden mb-6 space-y-2" data-testid="inventory-banner">
      {out.map((o) => (
        <Link
          key={o.name}
          href="/admin/inventory"
          data-testid="stock-out-banner"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive hover:bg-destructive/15"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-medium">{o.name} is out</span>
            {o.eightySixed ? ` · 86'd ${o.eightySixed}` : ""}
          </span>
        </Link>
      ))}
      {low.length ? (
        <Link
          href="/admin/inventory"
          data-testid="low-stock-banner"
          className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning hover:bg-warning/15"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-medium">Running low</span> ·{" "}
            {low.map((l) => `${l.name} (${formatQty(l.onHandMilli, l.baseUnit)})`).join(", ")}
          </span>
        </Link>
      ) : null}
    </div>
  );
}
