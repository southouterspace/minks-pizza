import { decimalHours, ROLE_LABEL } from "@/lib/timeclock";
import { centsToDollars } from "@/lib/money";
import { hhmmOf, localDateOf } from "@/lib/zoned";
import type { TimesheetRow } from "@/lib/staff/timesheets";

function csvCell(value: string | number): string {
  let s = String(value);
  // A leading = + - @ makes spreadsheets evaluate the cell.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * Payroll export: one `entry` line per closed punch, then one `total` line
 * per employee, in one rectangular table so it imports anywhere.
 */
export function timesheetCsv(rows: Pick<TimesheetRow, "employee" | "entries" | "closedPay">[], tz: string): string {
  const stamp = (d: Date) => `${localDateOf(d, tz)} ${hhmmOf(d, tz)}`;
  const lines: (string | number)[][] = [
    ["Line", "Employee", "Role", "Date", "In", "Out", "Unpaid break (min)", "Paid hours", "Rate", "Tips", "Regular hours", "OT hours", "DT hours", "Gross"],
  ];
  for (const row of rows) {
    for (const e of row.entries) {
      if (e.clockOutAt === null) continue;
      lines.push([
        "entry",
        row.employee.name,
        ROLE_LABEL[e.role],
        e.date,
        stamp(e.clockInAt),
        stamp(e.clockOutAt),
        e.breakMinutes,
        decimalHours(e.paidMinutes),
        centsToDollars(e.rateCents),
        centsToDollars(e.declaredTipsCents),
        "",
        "",
        "",
        "",
      ]);
    }
  }
  for (const row of rows) {
    if (row.closedPay.entries.length === 0) continue;
    const t = row.closedPay.totals;
    lines.push([
      "total",
      row.employee.name,
      "",
      "",
      "",
      "",
      t.breakMinutes,
      decimalHours(t.paidMinutes),
      "",
      centsToDollars(row.closedPay.tipsCents),
      decimalHours(t.regularMinutes),
      decimalHours(t.otMinutes),
      decimalHours(t.dtMinutes),
      centsToDollars(row.closedPay.grossCents),
    ]);
  }
  return lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
