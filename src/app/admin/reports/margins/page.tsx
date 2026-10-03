import type { Metadata } from "next";
import Link from "next/link";
import { requireOperator } from "@/lib/auth";
import { formatBps, marginReport } from "@/lib/inventory-reports";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExportLink, Kpis, Note, TableFrame } from "../report-ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Margins · Reports" };

export default async function MarginsPage() {
  await requireOperator();
  const { minMarginBps, rows } = await marginReport();
  const low = rows.filter((r) => r.low).length;
  const unknown = rows.filter((r) => r.plateCostCents === null).length;

  return (
    <>
      <div className="mt-4 flex justify-end">
        <ExportLink href="/api/admin/reports/margins" />
      </div>
      <Kpis
        items={[
          { label: "Minimum margin", value: formatBps(minMarginBps), hint: "set in Settings" },
          { label: "Below minimum", value: String(low), tone: low ? "text-destructive" : undefined },
          { label: "No recipe", value: String(unknown), hint: "plate cost unknown" },
        ]}
      />
      <Note>
        Price is the base price plus the size and the default options. Plate cost is what the recipes use at
        today&apos;s ingredient costs.
      </Note>
      <TableFrame>
        <Table data-testid="margin-table">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Item</TableHead>
              <TableHead>Size</TableHead>
              <TableHead className="text-right!">Price</TableHead>
              <TableHead className="text-right!">Plate cost</TableHead>
              <TableHead className="text-right!">Margin</TableHead>
              <TableHead className="pr-4 text-right!">Margin %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow
                key={`${r.itemId}-${r.sizeId}`}
                data-testid={`margin-${r.itemId}-${r.sizeId ?? "none"}`}
                data-low={r.low || undefined}
              >
                <TableCell className="pl-4">
                  <Link href={`/admin/menu/items/${r.itemId}`} className="block font-medium hover:underline">
                    {r.item}
                  </Link>
                  <span className="block text-xs text-muted-foreground">{r.category}</span>
                  {r.marginBps !== null ? (
                    <span className={cn("block text-xs tabular-nums sm:hidden", r.low && "text-destructive")}>
                      {formatBps(r.marginBps)} margin{r.low ? " · low" : ""}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground">{r.size ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCents(r.priceCents)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.plateCostCents === null ? (
                    <span className="text-muted-foreground">No recipe</span>
                  ) : (
                    formatCents(r.plateCostCents)
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.marginCents === null ? "—" : formatCents(r.marginCents)}
                </TableCell>
                <TableCell className={cn("pr-4 text-right tabular-nums", r.low && "text-destructive")}>
                  <span className="inline-flex items-center gap-2">
                    {r.low ? <Badge variant="destructive">Low</Badge> : null}
                    {formatBps(r.marginBps)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableFrame>
    </>
  );
}
