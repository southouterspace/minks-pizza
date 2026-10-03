import type { Metadata } from "next";
import Link from "next/link";
import { Download, SearchX } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import { ORDER_STATUSES, STATUS_META } from "@/lib/order-workflow";
import { PAGE_SIZE, parseOrderFilters, searchOrders, type OrderFilters } from "@/lib/orders-admin";
import { cn } from "@/lib/utils";
import { PaymentBadge, StatusBadge } from "@/components/admin/order-status";
import { formatDateTime } from "@/components/admin/ui";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Order history" };

/** The filters as a query string, so links and the CSV export share the URL state. */
function filterQuery(f: OrderFilters, page?: number): string {
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.status) params.set("status", f.status);
  if (f.type) params.set("type", f.type);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (page && page > 1) params.set("page", String(page));
  const s = params.toString();
  return s ? `?${s}` : "";
}

export default async function OrderHistoryPage({ searchParams }: PageProps<"/admin/orders">) {
  await requireOperator();
  const filters = parseOrderFilters(await searchParams);
  const { rows, total, page, pageCount, timezone } = await searchOrders(filters);
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, total);
  const filtered = Boolean(filters.q || filters.status || filters.type || filters.from || filters.to);

  return (
    <div data-wide>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Order history</h1>
        <a
          href={`/api/admin/orders/export${filterQuery(filters)}`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
          data-testid="export-csv"
        >
          <Download data-icon="inline-start" />
          Export CSV
        </a>
      </div>

      <form
        method="get"
        role="search"
        className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))_auto]"
      >
        <div className="col-span-2 grid gap-1.5 lg:col-span-1">
          <Label htmlFor="h-q">Search</Label>
          <Input
            id="h-q"
            name="q"
            type="search"
            defaultValue={filters.q}
            placeholder="Order #, name, phone or email"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="h-status">Status</Label>
          <NativeSelect id="h-status" name="status" defaultValue={filters.status ?? ""} className="w-full">
            <NativeSelectOption value="">Any status</NativeSelectOption>
            {ORDER_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {STATUS_META[s].label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="h-type">Type</Label>
          <NativeSelect id="h-type" name="type" defaultValue={filters.type ?? ""} className="w-full">
            <NativeSelectOption value="">Any type</NativeSelectOption>
            <NativeSelectOption value="pickup">Pickup</NativeSelectOption>
            <NativeSelectOption value="delivery">Delivery</NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="h-from">From</Label>
          <Input id="h-from" name="from" type="date" defaultValue={filters.from ?? ""} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="h-to">To</Label>
          <Input id="h-to" name="to" type="date" defaultValue={filters.to ?? ""} />
        </div>
        <div className="col-span-2 flex items-end gap-2 lg:col-span-1">
          <Button type="submit">Search</Button>
          {filtered ? (
            <Link href="/admin/orders" className={buttonVariants({ variant: "ghost" })}>
              Clear
            </Link>
          ) : null}
        </div>
      </form>

      {rows.length === 0 ? (
        <Empty className="mt-6 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX />
            </EmptyMedia>
            <EmptyTitle>No orders found</EmptyTitle>
            <EmptyDescription>
              {filtered ? "Try a wider date range or fewer filters." : "Orders show up here once customers check out."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="mt-6 overflow-hidden rounded-xl ring-1 ring-foreground/10">
            <Table data-testid="history-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Order</TableHead>
                  <TableHead className="hidden md:table-cell">Placed</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="hidden sm:table-cell">Type</TableHead>
                  <TableHead className="hidden sm:table-cell">Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Payment</TableHead>
                  <TableHead className="pr-4 text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => (
                  <TableRow key={o.id} data-testid={`history-row-${o.orderNumber}`} className="relative">
                    <TableCell className="pl-4 font-medium tabular-nums">
                      {/* The stretched link makes the whole row clickable. */}
                      <Link href={`/admin/orders/${o.id}`} className="after:absolute after:inset-0">
                        #{o.orderNumber}
                      </Link>
                      <span className="block text-xs font-normal text-muted-foreground md:hidden">
                        {formatDateTime(o.placedAt, timezone)}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground tabular-nums md:table-cell">
                      {formatDateTime(o.placedAt, timezone)}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <span className="block">{o.customerName}</span>
                      <span className="block text-xs text-muted-foreground">{o.customerPhone}</span>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {o.orderType === "delivery" ? "Delivery" : "Pickup"}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <StatusBadge status={o.status} />
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <PaymentBadge status={o.paymentStatus} method={o.paymentMethod} />
                    </TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">
                      {formatCents(o.totalCents)}
                      <span className="mt-1 block sm:hidden">
                        <StatusBadge status={o.status} />
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <nav
            aria-label="Pagination"
            className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"
          >
            <span data-testid="history-count">
              {first}–{last} of {total}
            </span>
            <span className="flex items-center gap-2">
              <Link
                href={`/admin/orders${filterQuery(filters, page - 1)}`}
                aria-disabled={page <= 1}
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  page <= 1 && "pointer-events-none opacity-50",
                )}
              >
                Previous
              </Link>
              <span className="tabular-nums">
                Page {page} of {pageCount}
              </span>
              <Link
                href={`/admin/orders${filterQuery(filters, page + 1)}`}
                aria-disabled={page >= pageCount}
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  page >= pageCount && "pointer-events-none opacity-50",
                )}
              >
                Next
              </Link>
            </span>
          </nav>
        </>
      )}
    </div>
  );
}
