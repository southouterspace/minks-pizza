/**
 * Back-office report reads: the shift list, day reports and CSV exports.
 * Every number comes from the same facts and folds as the shift close.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, drawerEvents, employees, orderItems, orders, shifts, tenders } from "@/db";
import { modifierLabel, reconcileDrawer, salesReport, type DrawerReconciliation, type SalesReport } from "@/lib/orders";
import { loadReportFacts, reportOrderIds, tendersIn, type ReportScope } from "@/lib/orders-server";
import { formatStoreTimestamp, parseStoreDate, storeDateOf, storeDayRange, type StoreDate } from "@/lib/store-time";

export type ShiftSummary = {
  id: string;
  openedAt: Date;
  openedBy: string;
  closedAt: Date | null;
  closedBy: string | null;
  startingBankCents: number;
} & DrawerReconciliation;

const opener = alias(employees, "opener");
const closer = alias(employees, "closer");

function shiftRows(where: SQL | undefined) {
  return db
    .select({ shift: shifts, openedBy: opener.name, closedBy: closer.name })
    .from(shifts)
    .innerJoin(opener, eq(opener.id, shifts.openedBy))
    .leftJoin(closer, eq(closer.id, shifts.closedBy))
    .where(where)
    .orderBy(desc(shifts.openedAt));
}

/** Shifts opened on a store day, plus any shift still open, newest first. */
export async function listShifts(day: { from: Date; to: Date }): Promise<ShiftSummary[]> {
  const rows = await shiftRows(
    or(and(gte(shifts.openedAt, day.from), lt(shifts.openedAt, day.to)), isNull(shifts.closedAt)),
  );
  const ids = rows.map((r) => r.shift.id);
  const [tenderRows, drawerRows] = ids.length
    ? await Promise.all([
        db.select().from(tenders).where(inArray(tenders.shiftId, ids)),
        db.select().from(drawerEvents).where(inArray(drawerEvents.shiftId, ids)),
      ])
    : [[], []];
  return rows.map(({ shift, openedBy, closedBy }) => ({
    id: shift.id,
    openedAt: shift.openedAt,
    openedBy,
    closedAt: shift.closedAt,
    closedBy,
    startingBankCents: shift.startingBankCents,
    ...reconcileDrawer(shift, {
      tenders: tenderRows.filter((t) => t.shiftId === shift.id),
      drawerEvents: drawerRows.filter((e) => e.shiftId === shift.id),
    }),
  }));
}

export async function getShift(id: string) {
  const [row] = await shiftRows(eq(shifts.id, id));
  return row ?? null;
}

export async function getDayReport(date: StoreDate, tz: string): Promise<SalesReport> {
  return salesReport(await loadReportFacts({ kind: "day", ...storeDayRange(date, tz) }));
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?shift=<id>` or `?date=YYYY-MM-DD`, as the report pages and CSV routes take it. */
export async function resolveScope(
  query: { shift?: string | null; date?: string | null },
  tz: string,
): Promise<{ scope: ReportScope; label: string } | null> {
  if (query.shift) {
    const row = UUID_RE.test(query.shift) ? await getShift(query.shift) : null;
    if (!row) return null;
    const { shift } = row;
    return {
      scope: { kind: "shift", shiftId: shift.id, from: shift.openedAt, to: shift.closedAt },
      label: `shift-${storeDateOf(shift.openedAt, tz)}-${shift.id.slice(0, 8)}`,
    };
  }
  const date = parseStoreDate(query.date ?? undefined);
  return date ? { scope: { kind: "day", ...storeDayRange(date, tz) }, label: date } : null;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

type Cell = string | number | null;

/**
 * Text cells that start like a formula get a leading apostrophe: names,
 * notes and reasons are typed by customers and staff, and spreadsheet apps
 * run "=..." cells. Numbers are written as-is so they stay numeric.
 */
function csvCell(v: Cell): string {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  const text = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const dollars = (cents: number) => Number((cents / 100).toFixed(2));

export async function orderLinesCsv(scope: ReportScope, tz: string): Promise<string> {
  const voider = alias(employees, "voider");
  const approver = alias(employees, "approver");
  const rows = await db
    .select({ o: orders, i: orderItems, voidedBy: voider.name, approvedBy: approver.name })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .leftJoin(voider, eq(voider.id, orderItems.voidedBy))
    .leftJoin(approver, eq(approver.id, orderItems.voidApprovedBy))
    .where(inArray(orders.id, reportOrderIds(scope)))
    .orderBy(asc(orders.orderNumber), asc(orderItems.id));
  return toCsv(
    [
      "order_number",
      "placed_at_local",
      "channel",
      "order_type",
      "status",
      "customer",
      "item",
      "quantity",
      "unit_price",
      "line_total",
      "modifiers",
      "notes",
      "voided_at_local",
      "void_reason",
      "voided_by",
      "void_approved_by",
    ],
    rows.map(({ o, i, voidedBy, approvedBy }) => [
      o.orderNumber,
      formatStoreTimestamp(o.placedAt, tz),
      o.channel,
      o.orderType,
      o.status,
      o.customerName,
      i.itemName,
      i.quantity,
      dollars(i.unitPriceCents),
      dollars(i.lineTotalCents),
      i.modifiers.map(modifierLabel).join("; "),
      i.notes,
      i.voidedAt ? formatStoreTimestamp(i.voidedAt, tz) : null,
      i.voidReason,
      voidedBy,
      approvedBy,
    ]),
  );
}

export async function tendersCsv(scope: ReportScope, tz: string): Promise<string> {
  const taker = alias(employees, "taker");
  const approver = alias(employees, "approver");
  const rows = await db
    .select({ t: tenders, number: orders.orderNumber, employee: taker.name, approvedBy: approver.name })
    .from(tenders)
    .innerJoin(orders, eq(orders.id, tenders.orderId))
    .leftJoin(taker, eq(taker.id, tenders.employeeId))
    .leftJoin(approver, eq(approver.id, tenders.approvedBy))
    .where(tendersIn(scope))
    .orderBy(asc(tenders.createdAt));
  return toCsv(
    ["at_local", "order_number", "direction", "method", "amount", "tip", "tendered", "change", "last4", "employee", "approved_by", "reason", "tender_id"],
    rows.map(({ t, number, employee, approvedBy }) => [
      formatStoreTimestamp(t.createdAt, tz),
      number,
      t.direction,
      t.method,
      dollars(t.amountCents),
      dollars(t.tipCents),
      t.tenderedCents === null ? null : dollars(t.tenderedCents),
      t.tenderedCents === null ? null : dollars(t.tenderedCents - t.amountCents),
      t.last4,
      employee,
      approvedBy,
      t.reason,
      t.id,
    ]),
  );
}
