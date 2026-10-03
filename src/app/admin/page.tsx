import type { Metadata } from "next";
import Link from "next/link";
import { asc, inArray } from "drizzle-orm";
import { db, orders } from "@/db";
import { requireOperator } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import { ACTIVE_STATUSES, type OrderStatus } from "@/lib/order-workflow";
import { getDashboardStats, getStoreTimezone } from "@/lib/orders-admin";
import { cn } from "@/lib/utils";
import { AutoRefresh } from "@/components/admin/auto-refresh";
import { BoardCard } from "@/components/admin/board-card";
import { NewOrderAlert } from "@/components/admin/new-order-alert";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Orders" };

const LANES: { title: string; statuses: readonly OrderStatus[]; empty: string }[] = [
  { title: "New", statuses: ["new"], empty: "New orders land here." },
  {
    title: "In kitchen",
    statuses: ["confirmed", "preparing"],
    empty: "Confirmed orders move here.",
  },
  { title: "Ready", statuses: ["ready"], empty: "Nothing waiting for pickup." },
];

export default async function OrdersBoardPage() {
  await requireOperator();
  const now = new Date();

  const [active, stats, timeZone] = await Promise.all([
    db.query.orders.findMany({
      where: inArray(orders.status, [...ACTIVE_STATUSES]),
      with: { items: true },
      orderBy: [asc(orders.placedAt)],
    }),
    getDashboardStats(now),
    getStoreTimezone(),
  ]);

  const kpis = [
    {
      label: "Orders today",
      value: String(stats.orders),
      hint: stats.canceled > 0 ? `${stats.canceled} canceled` : undefined,
    },
    { label: "Net sales", value: formatCents(stats.netSalesCents) },
    {
      label: "Avg ticket",
      value: stats.avgTicketCents === null ? "—" : formatCents(stats.avgTicketCents),
    },
    {
      label: "Avg ready time",
      value: stats.avgReadyMinutes === null ? "—" : `${stats.avgReadyMinutes} min`,
    },
    {
      label: "Late now",
      value: String(stats.late),
      tone: stats.late > 0 ? "text-destructive" : undefined,
      hint: `${stats.active} active`,
    },
  ];

  return (
    <div data-wide>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Orders</h1>
        <div className="flex items-center gap-2">
          <NewOrderAlert
            newOrderIds={active.filter((o) => o.status === "new").map((o) => o.id)}
          />
          <AutoRefresh />
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="kpi-strip">
        {kpis.map((k) => (
          <div
            key={k.label}
            className="rounded-xl px-3 py-2.5 ring-1 ring-foreground/10 last:col-span-2 sm:last:col-span-1"
          >
            <dt className="text-xs text-muted-foreground">{k.label}</dt>
            <dd className={cn("mt-0.5 text-lg font-semibold tabular-nums", k.tone)}>
              {k.value}
            </dd>
            {k.hint ? <dd className="text-xs text-muted-foreground">{k.hint}</dd> : null}
          </div>
        ))}
      </dl>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {LANES.map((lane) => {
          const laneOrders = active.filter((o) => lane.statuses.includes(o.status));
          return (
            <section key={lane.title} aria-label={lane.title} data-testid={`lane-${lane.title}`}>
              <h2 className="flex items-center gap-2 text-sm font-medium">
                {lane.title}
                <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
                  {laneOrders.length}
                </span>
              </h2>
              <div className="mt-2 space-y-2">
                {laneOrders.length === 0 ? (
                  <p className="rounded-xl border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                    {lane.empty}
                  </p>
                ) : (
                  laneOrders.map((order) => (
                    <BoardCard key={order.id} order={order} now={now} timeZone={timeZone} />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>

      <p className="mt-6 text-sm text-muted-foreground">
        Completed and canceled orders are in{" "}
        <Link href="/admin/orders" className="text-foreground underline underline-offset-4">
          History
        </Link>
        .
      </p>
    </div>
  );
}
