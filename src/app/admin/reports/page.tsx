import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Download, FileText } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import { getStoreBasics } from "@/lib/settings-server";
import { getDayReport, listShifts } from "@/lib/reports-server";
import { addDays, formatLongDay, formatClock, localDateSchema, localDateOf, dayBounds } from "@/lib/zoned";
import { formatDateTime } from "@/components/admin/ui";
import { overShortLabel, overShortTone } from "@/components/admin/report-document";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();
  const settings = await getStoreBasics();
  const tz = settings.timezone;
  const today = localDateOf(new Date(), tz);
  const raw = (await searchParams).date;
  const parsed = localDateSchema.safeParse(raw);
  const date = parsed.success ? parsed.data : today;
  const [report, shifts] = await Promise.all([getDayReport(date, tz), listShifts(dayBounds(date, tz))]);
  const cash = report.byMethod.find((m) => m.method === "cash")!;
  const card = report.byMethod.find((m) => m.method === "card_external")!;
  const exceptions = report.audit.filter((a) => a.kind !== "paid_in").length;

  const stats = [
    { label: "Net sales", value: formatCents(report.sales.netCents), sub: `${report.sales.orders} orders` },
    { label: "Cash taken", value: formatCents(cash.netCents), sub: `${cash.payments} payments` },
    { label: "Card taken", value: formatCents(card.netCents), sub: `incl. ${formatCents(card.tipCents)} tips` },
    { label: "Exceptions", value: String(exceptions), sub: "voids, comps, refunds…" },
    { label: "Unpaid", value: String(report.unpaidOrders.length), sub: "orders still owing" },
  ];

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Day</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatLongDay(date)}
            {date === today ? " (today)" : ""}
          </p>
        </div>
        <form method="get" className="flex items-center gap-1.5">
          <Link
            href={`/admin/reports?date=${addDays(date, -1)}`}
            aria-label="Previous day"
            className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
          >
            <ChevronLeft aria-hidden="true" />
          </Link>
          <label htmlFor="report-date" className="sr-only">
            Day
          </label>
          <Input id="report-date" name="date" type="date" defaultValue={date} max={today} className="w-auto" />
          <Button type="submit" variant="outline" size="sm">
            Show
          </Button>
          <Link
            href={`/admin/reports?date=${addDays(date, 1)}`}
            aria-label="Next day"
            aria-disabled={date >= today}
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon-sm" }),
              date >= today && "pointer-events-none opacity-40",
            )}
          >
            <ChevronRight aria-hidden="true" />
          </Link>
        </form>
      </div>

      <section className="mt-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {stats.map((s) => (
            <Card key={s.label} className="gap-0.5! px-4 py-3!">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="text-lg font-semibold tabular-nums">{s.value}</p>
              <p className="text-xs text-muted-foreground">{s.sub}</p>
            </Card>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={`/admin/reports/day/${date}`} className={buttonVariants({ size: "sm" })}>
            <FileText aria-hidden="true" />
            Day report
          </Link>
          <a href={`/api/admin/reports/lines?date=${date}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Download aria-hidden="true" />
            Order lines CSV
          </a>
          <a href={`/api/admin/reports/tenders?date=${date}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Download aria-hidden="true" />
            Tenders CSV
          </a>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-muted-foreground">Shifts</h2>
        {shifts.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No shift was opened this day.</p>
        ) : (
          <Card className="mt-3 gap-0! py-0!">
            {shifts.map((s, i) => (
              <Link
                key={s.id}
                href={`/admin/reports/shift/${s.id}`}
                data-testid="shift-row"
                className={cn(
                  "flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 transition-colors hover:bg-muted/50",
                  i > 0 && "border-t border-border",
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {s.closedAt ? (
                      <Badge variant="secondary">Closed</Badge>
                    ) : (
                      <Badge variant="outline" className="border-transparent! bg-success/10 text-success!">
                        Open
                      </Badge>
                    )}
                    {localDateOf(s.openedAt, tz) === date
                      ? formatClock(s.openedAt, tz)
                      : formatDateTime(s.openedAt, tz)}
                    {" – "}
                    {s.closedAt ? formatClock(s.closedAt, tz) : "now"}
                  </p>
                  <p data-testid="shift-people" className="mt-0.5 text-xs text-muted-foreground">
                    Opened by {s.openedBy}
                    {s.closedBy ? ` · closed by ${s.closedBy}` : ""}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-x-6 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Cash</p>
                    <p
                      data-testid="shift-cash"
                      className={cn("font-medium tabular-nums", s.closedAt && overShortTone(s.cashOverShortCents))}
                    >
                      {s.closedAt ? overShortLabel(s.cashOverShortCents) : `${formatCents(s.expectedCashCents)} in drawer`}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Card</p>
                    <p
                      data-testid="shift-card"
                      className={cn("font-medium tabular-nums", s.closedAt && overShortTone(s.cardOverShortCents))}
                    >
                      {s.closedAt ? overShortLabel(s.cardOverShortCents) : formatCents(s.cardTotalCents)}
                    </p>
                  </div>
                </div>
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
              </Link>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}
