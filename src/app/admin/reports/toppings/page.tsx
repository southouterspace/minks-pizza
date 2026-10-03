import type { Metadata } from "next";
import { Pizza } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import {
  attachBps,
  extraShareBps,
  formatBps,
  halfShareBps,
  lightShareBps,
  rangeQuery,
  toppingMixReport,
} from "@/lib/inventory-reports";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Note, RangeForm, TableFrame } from "../report-ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Topping mix · Reports" };

export default async function ToppingMixPage({ searchParams }: PageProps<"/admin/reports/toppings">) {
  await requireOperator();
  const { range, sizes } = await toppingMixReport(await searchParams);

  return (
    <>
      <RangeForm range={range} csv={`/api/admin/reports/toppings${rangeQuery(range)}`} />
      <Note>
        How often each topping goes on a pizza of each size in completed orders, counting every pizza in a
        line. Half, light and extra are shares of the pizzas that had the topping.
      </Note>
      {sizes.length === 0 ? (
        <Empty className="mt-6 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Pizza />
            </EmptyMedia>
            <EmptyTitle>No pizzas sold in this range</EmptyTitle>
            <EmptyDescription>Try a wider date range.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        sizes.map((s) => (
          <section key={s.sizeId} className="mt-6" data-testid={`size-${s.sizeId}`}>
            <h2 className="text-sm font-medium">
              {s.size}{" "}
              <span className="font-normal text-muted-foreground">
                · {s.pizzas} {s.pizzas === 1 ? "pizza" : "pizzas"}
              </span>
            </h2>
            {s.rows.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No toppings added at this size.</p>
            ) : (
              <TableFrame className="mt-2">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Topping</TableHead>
                      <TableHead className="text-right!">Pizzas</TableHead>
                      <TableHead className="min-w-36">Attach rate</TableHead>
                      <TableHead className="text-right!">Half</TableHead>
                      <TableHead className="text-right!">Light</TableHead>
                      <TableHead className="pr-4 text-right!">Extra</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {s.rows.map((r) => {
                      const attach = attachBps(r) ?? 0;
                      return (
                        <TableRow key={r.toppingId} data-testid={`topping-${s.sizeId}-${r.toppingId}`}>
                          <TableCell className="pl-4 font-medium">{r.topping}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.withTopping}</TableCell>
                          <TableCell>
                            <span className="flex items-center gap-2">
                              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                                <span
                                  className="block h-full rounded-full bg-foreground/70"
                                  style={{ width: `${attach / 100}%` }}
                                />
                              </span>
                              <span className="tabular-nums">{formatBps(attach)}</span>
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatBps(halfShareBps(r))}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatBps(lightShareBps(r))}</TableCell>
                          <TableCell className="pr-4 text-right tabular-nums">{formatBps(extraShareBps(r))}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableFrame>
            )}
          </section>
        ))
      )}
    </>
  );
}
