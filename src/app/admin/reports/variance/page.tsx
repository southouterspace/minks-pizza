import type { Metadata } from "next";
import { ClipboardList } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import { formatBps, ratioBps, varianceReport, type CountSummary } from "@/lib/inventory-reports";
import { formatCents } from "@/lib/money";
import { getStoreTimezone } from "@/lib/order-queries";
import { formatQty } from "@/lib/units";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExportLink, Kpis, Note, TableFrame } from "../report-ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Variance · Reports" };

const countLabel = (c: CountSummary, timezone: string) =>
  `${formatDateTime(c.createdAt, timezone)} · ${c.kind === "full" ? "Full" : "Spot"} count · ${c.ingredients} items`;

const signedCents = (cents: number) => (cents > 0 ? `+${formatCents(cents)}` : formatCents(cents));
const loss = (n: number) => (n < 0 ? "text-destructive" : undefined);

export default async function VariancePage({ searchParams }: PageProps<"/admin/reports/variance">) {
  await requireOperator();
  const [report, timezone] = await Promise.all([varianceReport(await searchParams), getStoreTimezone()]);
  const { counts, count, rows } = report;

  if (!count) {
    return (
      <Empty className="mt-6 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ClipboardList />
          </EmptyMedia>
          <EmptyTitle>No counts yet</EmptyTitle>
          <EmptyDescription>
            Count your stock from Inventory. Each count compares what you have with what the recipes say you should.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <form method="get" className="flex min-w-0 flex-wrap items-end gap-3">
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor="v-count">Count</Label>
            <NativeSelect id="v-count" name="count" defaultValue={String(count.id)} className="w-full max-w-80">
              {counts.map((c) => (
                <NativeSelectOption key={c.id} value={c.id}>
                  {countLabel(c, timezone)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit">Show</Button>
        </form>
        <ExportLink href={`/api/admin/reports/variance?count=${count.id}`} />
      </div>
      <Kpis
        items={[
          { label: "Theoretical usage", value: formatCents(report.usageCents) },
          {
            label: "Variance",
            value: signedCents(report.varianceCents),
            tone: loss(report.varianceCents),
            hint: report.usageCents ? `${formatBps(ratioBps(report.varianceCents, report.usageCents))} of usage` : undefined,
          },
        ]}
      />
      <Note>
        Each ingredient in this count, since its previous count. Expected = opening + received − wasted −
        theoretical usage; variance = counted − expected. Sorted by theoretical dollar usage, so the ingredient
        that costs you the most (usually mozzarella) is on top.
      </Note>
      <TableFrame>
        <Table data-testid="variance-table">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Ingredient</TableHead>
              <TableHead className="text-right!">Opening</TableHead>
              <TableHead className="text-right!">Received</TableHead>
              <TableHead className="text-right!">Wasted</TableHead>
              <TableHead className="text-right!">Usage</TableHead>
              <TableHead className="text-right!">Expected</TableHead>
              <TableHead className="text-right!">Counted</TableHead>
              <TableHead className="text-right!">Variance</TableHead>
              <TableHead className="text-right!">Usage $</TableHead>
              <TableHead className="pr-4 text-right!">Variance $</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const q = (milli: number) => formatQty(milli, r.baseUnit);
              return (
                <TableRow key={r.ingredientId} data-testid={`variance-row-${r.ingredientId}`}>
                  <TableCell className="pl-4">
                    <span className="block font-medium">{r.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {r.since ? `since ${formatDateTime(r.since, timezone)}` : "since first move"}
                    </span>
                    <span className={cn("block text-xs tabular-nums sm:hidden", loss(r.varianceCents))}>
                      {r.varianceMilli > 0 ? "+" : ""}
                      {q(r.varianceMilli)} · {signedCents(r.varianceCents)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{q(r.openingMilli)}</TableCell>
                  <TableCell className="text-right tabular-nums">{q(r.receivedMilli)}</TableCell>
                  <TableCell className="text-right tabular-nums">{q(r.wastedMilli)}</TableCell>
                  <TableCell className="text-right tabular-nums">{q(r.usageMilli)}</TableCell>
                  <TableCell className="text-right tabular-nums">{q(r.expectedMilli)}</TableCell>
                  <TableCell className="text-right tabular-nums">{q(r.countedMilli)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", loss(r.varianceMilli))}>
                    {r.varianceMilli > 0 ? "+" : ""}
                    {q(r.varianceMilli)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCents(r.usageCents)}</TableCell>
                  <TableCell className={cn("pr-4 text-right tabular-nums", loss(r.varianceCents))}>
                    {signedCents(r.varianceCents)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="pl-4 font-medium" colSpan={8}>
                Total
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCents(report.usageCents)}</TableCell>
              <TableCell className={cn("pr-4 text-right tabular-nums", loss(report.varianceCents))}>
                {signedCents(report.varianceCents)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </TableFrame>
    </>
  );
}
