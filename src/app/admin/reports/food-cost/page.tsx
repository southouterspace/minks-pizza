import type { Metadata } from "next";
import { requireOperator } from "@/lib/auth";
import {
  coverageBps,
  foodCostBps,
  foodCostReport,
  formatBps,
  rangeQuery,
  type FoodCostTotals,
} from "@/lib/inventory-reports";
import { formatCents } from "@/lib/money";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Kpis, Note, RangeForm, TableFrame } from "../report-ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Food cost · Reports" };

const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });

function Cells({ row }: { row: FoodCostTotals }) {
  const empty = row.orders === 0;
  return (
    <>
      <TableCell className="text-right tabular-nums">{row.orders}</TableCell>
      <TableCell className="text-right tabular-nums">{empty ? "—" : formatCents(row.netSalesCents)}</TableCell>
      <TableCell className="text-right tabular-nums">{row.costedSalesCents === 0 ? "—" : formatCents(row.cogsCents)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatBps(foodCostBps(row))}</TableCell>
      <TableCell className="pr-4 text-right tabular-nums text-muted-foreground">{formatBps(coverageBps(row))}</TableCell>
    </>
  );
}

export default async function FoodCostPage({ searchParams }: PageProps<"/admin/reports/food-cost">) {
  await requireOperator();
  const { range, days, total } = await foodCostReport(await searchParams);
  const coverage = coverageBps(total);

  return (
    <>
      <RangeForm range={range} csv={`/api/admin/reports/food-cost${rangeQuery(range)}`} />
      <Kpis
        items={[
          { label: "Net sales", value: formatCents(total.netSalesCents), hint: `${total.orders} completed orders` },
          { label: "Theoretical COGS", value: formatCents(total.cogsCents) },
          { label: "Food cost", value: formatBps(foodCostBps(total)) },
          {
            label: "Cost known for",
            value: formatBps(coverage),
            hint: "of sales",
            tone: coverage !== null && coverage < 10_000 ? "text-amber-600 dark:text-amber-500" : undefined,
          },
        ]}
      />
      <Note>
        Theoretical cost is what the recipes say each completed order used.
        {coverage !== null && coverage < 10_000
          ? ` Cost is known for ${formatBps(coverage)} of sales; lines sold before recipes existed have none, so food cost % is taken over the costed sales only.`
          : null}
      </Note>
      <TableFrame>
        <Table data-testid="food-cost-table">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Day</TableHead>
              <TableHead className="text-right!">Orders</TableHead>
              <TableHead className="text-right!">Net sales</TableHead>
              <TableHead className="text-right!">COGS</TableHead>
              <TableHead className="text-right!">Food cost</TableHead>
              <TableHead className="pr-4 text-right!">Cost known</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {days.map((row) => (
              <TableRow key={row.day} data-testid={`day-${row.day}`}>
                <TableCell className="pl-4 tabular-nums">{dayLabel(row.day)}</TableCell>
                <Cells row={row} />
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow data-testid="day-total">
              <TableCell className="pl-4 font-medium">Total</TableCell>
              <Cells row={total} />
            </TableRow>
          </TableFooter>
        </Table>
      </TableFrame>
    </>
  );
}
