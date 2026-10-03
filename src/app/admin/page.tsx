import type { Metadata } from "next";
import { desc, inArray } from "drizzle-orm";
import { Inbox } from "lucide-react";
import { db, orders } from "@/db";
import { requireOperator } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import { channelLabel } from "@/lib/orders";
import { getStoreBasics, listOrderViews } from "@/lib/orders-server";
import { formatStoreDateTime } from "@/lib/store-time";
import { AutoRefresh } from "@/components/admin/auto-refresh";
import { OrderCard, StatusBadge } from "@/components/admin/order-card";
import { Card } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Orders" };

export default async function OrdersPage() {
  await requireOperator();

  const [{ timezone: tz }, activeOrders, held] = await Promise.all([
    getStoreBasics(),
    listOrderViews(["new", "preparing", "ready"]),
    listOrderViews(["held"]),
  ]);
  const scheduledOrders = held.toSorted((a, b) => (a.fireAt ?? "~").localeCompare(b.fireAt ?? "~"));

  const recentOrders = await db
    .select()
    .from(orders)
    .where(inArray(orders.status, ["completed", "canceled"]))
    .orderBy(desc(orders.placedAt))
    .limit(20);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Orders</h1>
        <AutoRefresh />
      </div>

      {/* Active */}
      <section className="mt-6">
        <h2 className="text-sm font-medium text-muted-foreground">
          Active{activeOrders.length > 0 ? ` (${activeOrders.length})` : ""}
        </h2>
        {activeOrders.length === 0 ? (
          <Empty className="mt-3 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>No orders yet</EmptyTitle>
              <EmptyDescription>
                They&apos;ll appear here the moment a customer checks out.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="mt-3 space-y-4">
            {activeOrders.map((order) => (
              <OrderCard key={order.id} order={order} tz={tz} />
            ))}
          </div>
        )}
      </section>

      {scheduledOrders.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-muted-foreground">
            Scheduled ({scheduledOrders.length})
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Held back from the kitchen until their fire time.
          </p>
          <div className="mt-3 space-y-4">
            {scheduledOrders.map((order) => (
              <OrderCard key={order.id} order={order} tz={tz} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Recent */}
      <section className="mt-8">
        <details>
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
            Recent ({recentOrders.length})
          </summary>
          {recentOrders.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Completed and canceled orders will show up here.
            </p>
          ) : (
            <Card className="mt-3 gap-0! py-0!">
              <ul className="divide-y divide-border">
                {recentOrders.map((order) => (
                  <li
                    key={order.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
                  >
                    <span className="font-medium tabular-nums">
                      #{order.orderNumber}
                    </span>
                    <StatusBadge status={order.status} />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {order.customerName} ·{" "}
                      {channelLabel(order.channel, order.orderType)}
                    </span>
                    <span className="tabular-nums">
                      {formatCents(order.totalCents)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatStoreDateTime(order.placedAt, tz)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </details>
      </section>
    </div>
  );
}
