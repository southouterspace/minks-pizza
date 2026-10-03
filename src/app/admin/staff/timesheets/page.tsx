import type { Metadata } from "next";
import { CheckCircle2, Download } from "lucide-react";
import { asc } from "drizzle-orm";
import { db, employees } from "@/db";
import { requireOperator } from "@/lib/auth";
import { approveTimesheet, deletePunch } from "@/app/admin/staff/actions";
import { formatCents } from "@/lib/money";
import { decimalHours, FLAG_META, formatDuration, ROLE_LABEL, type Severity } from "@/lib/timeclock";
import {
  getStaffConfig,
  getTimesheetWeek,
  resolveWeek,
  type TimesheetEntry,
} from "@/lib/timeclock-server";
import { formatClock, formatDay, hhmmOf, localDateOf, weekDates } from "@/lib/zoned";
import { ConfirmButton } from "@/components/admin/confirm-button";
import { PunchDialog, type PunchEmployee } from "@/components/staff/punch-dialog";
import { WeekNav } from "@/components/staff/week-nav";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Timesheets" };

const SEVERITY_TONE: Record<Severity, string> = {
  critical: "border-destructive/40 bg-destructive/10 text-destructive",
  warning: "border-warning/40 bg-warning/10 text-warning",
  info: "border-border bg-muted text-muted-foreground",
};

const AUDIT_LABEL: Record<string, string> = {
  create: "Added",
  edit: "Edited",
  delete: "Deleted",
  approve: "Approved",
  unapprove: "Approval cleared",
  clock_out: "Clocked out by a manager",
};

const GRID = "grid grid-cols-[minmax(9rem,1fr)_repeat(7,3.25rem)_repeat(3,3.25rem)_4.5rem_5.5rem_3rem_7.5rem] items-center gap-x-1";

export default async function TimesheetsPage({ searchParams }: PageProps<"/admin/staff/timesheets">) {
  await requireOperator();
  const params = await searchParams;
  const cfg = await getStaffConfig();
  const tz = cfg.timezone;
  const thisWeek = resolveWeek(undefined, cfg);
  const weekStart = resolveWeek(params.week, cfg);
  const [rows, people] = await Promise.all([
    getTimesheetWeek(weekStart, cfg),
    db.query.employees.findMany({
      columns: { id: true, name: true },
      with: { roles: { columns: { role: true } } },
      orderBy: [asc(employees.name)],
    }),
  ]);
  const punchEmployees: PunchEmployee[] = people.map((p) => ({ id: p.id, name: p.name, roles: p.roles.map((r) => r.role) }));
  const dates = weekDates(weekStart);
  const local = (d: Date) => `${localDateOf(d, tz)}T${hhmmOf(d, tz)}`;
  const approvable = rows.some((r) => !r.hasOpen && r.entries.some((e) => e.approvedAt === null));

  return (
    <div data-wide>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Timesheets</h1>
        <div className="flex flex-wrap items-center gap-2">
          <PunchDialog
            punch={{
              id: null,
              employeeId: null,
              role: null,
              clockIn: `${weekStart}T16:00`,
              clockOut: "",
              breaks: [],
              tipsDollars: "",
              note: "",
              approved: false,
            }}
            employees={punchEmployees}
            trigger="Add missed punch"
          />
          <a href={`/api/admin/timesheets?week=${weekStart}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Download /> Export CSV
          </a>
          <form action={approveTimesheet}>
            <input type="hidden" name="week" value={weekStart} />
            <Button type="submit" size="sm" disabled={!approvable} data-testid="approve-all">
              Approve all
            </Button>
          </form>
        </div>
      </div>
      <div className="mt-3">
        <WeekNav path="/admin/staff/timesheets" weekStart={weekStart} thisWeek={thisWeek} />
      </div>
      {params.approved !== undefined ? (
        <p role="status" className="mt-3 text-sm font-medium text-success">
          Approved {params.approved} {params.approved === "1" ? "punch" : "punches"}.
        </p>
      ) : null}

      <Card className="mt-4 gap-0! overflow-x-auto py-0!">
        <div className="min-w-[1040px] text-sm">
          <div className={cn(GRID, "border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground")}>
            <span>Employee</span>
            {dates.map((d) => (
              <span key={d} className="text-right">
                {formatDay(d).slice(0, 3)}
              </span>
            ))}
            <span className="text-right">Reg</span>
            <span className="text-right">OT</span>
            <span className="text-right">DT</span>
            <span className="text-right">Tips</span>
            <span className="text-right">Est. gross</span>
            <span className="text-right">Flags</span>
            <span className="text-right">Status</span>
          </div>
          {rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-muted-foreground">No employees yet.</p>
          ) : null}
          {rows.map((row) => {
            const byDate = new Map(row.pay.days.map((d) => [d.date, d.paidMinutes]));
            return (
              <details key={row.employee.id} className="group border-b border-border last:border-b-0" data-testid="timesheet-row">
                <summary className={cn(GRID, "cursor-pointer list-none px-3 py-2 hover:bg-muted/50 [&::-webkit-details-marker]:hidden")}>
                  <span className="truncate font-medium">
                    {row.employee.name}
                    {row.employee.isActive ? null : <span className="ml-1 text-xs text-muted-foreground">(archived)</span>}
                  </span>
                  {dates.map((d) => (
                    <span key={d} className={cn("text-right tabular-nums", !byDate.has(d) && "text-muted-foreground/50")}>
                      {byDate.has(d) ? decimalHours(byDate.get(d)!) : "–"}
                    </span>
                  ))}
                  <span className="text-right tabular-nums">{decimalHours(row.pay.totals.regularMinutes)}</span>
                  <span className={cn("text-right tabular-nums", row.pay.totals.otMinutes > 0 && "font-medium text-warning")}>
                    {decimalHours(row.pay.totals.otMinutes)}
                  </span>
                  <span className="text-right tabular-nums">{decimalHours(row.pay.totals.dtMinutes)}</span>
                  <span className="text-right tabular-nums">{formatCents(row.pay.tipsCents)}</span>
                  <span className="text-right font-medium tabular-nums" data-testid="timesheet-gross">
                    {formatCents(row.pay.grossCents)}
                  </span>
                  <span className={cn("text-right tabular-nums", row.flagCount > 0 && "font-medium text-warning")}>
                    {row.flagCount}
                  </span>
                  <span className="flex justify-end" data-testid="timesheet-status">
                    {row.entries.length === 0 ? (
                      <span className="text-xs text-muted-foreground">No punches</span>
                    ) : row.approved ? (
                      <span className="flex items-center gap-1 text-xs font-medium text-success">
                        <CheckCircle2 className="size-3.5" aria-hidden="true" /> Approved
                      </span>
                    ) : row.hasOpen ? (
                      <span className="text-xs text-muted-foreground">On the clock</span>
                    ) : (
                      <span className="text-xs text-warning">Needs approval</span>
                    )}
                  </span>
                </summary>

                <div className="space-y-3 bg-muted/30 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {!row.approved && !row.hasOpen && row.entries.length > 0 ? (
                      <form action={approveTimesheet}>
                        <input type="hidden" name="week" value={weekStart} />
                        <input type="hidden" name="employeeId" value={row.employee.id} />
                        <Button type="submit" size="sm" data-testid="approve-employee">
                          Approve {row.employee.name.split(" ")[0]}&apos;s week
                        </Button>
                      </form>
                    ) : null}
                    {row.hasOpen ? (
                      <span className="text-xs text-muted-foreground">Open punches can&apos;t be approved until they close.</span>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      {decimalHours(row.pay.totals.paidMinutes)} h paid · straight {formatCents(row.pay.straightCents)} + OT
                      premium {formatCents(row.pay.premiumCents)}
                    </span>
                  </div>
                  {row.entries.map((e) => (
                    <EntryCard key={e.id} entry={e} tz={tz} employees={punchEmployees} employeeId={row.employee.id} local={local} />
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">
        Each punch counts toward the day it started. Overtime pay uses the weighted-average regular rate when someone
        works more than one rate. Export includes closed punches only.
      </p>
    </div>
  );
}

function EntryCard({
  entry: e,
  tz,
  employees,
  employeeId,
  local,
}: {
  entry: TimesheetEntry;
  tz: string;
  employees: PunchEmployee[];
  employeeId: number;
  local: (d: Date) => string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3" data-testid="timesheet-entry">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium">{formatDay(e.date)}</span>
        <span className="tabular-nums">
          {formatClock(e.clockInAt, tz)} to {e.clockOutAt ? formatClock(e.clockOutAt, tz) : "now"}
        </span>
        <span className="text-muted-foreground">
          {ROLE_LABEL[e.role]} · ${(e.rateCents / 100).toFixed(2)}/h
        </span>
        <span className="font-medium tabular-nums">{formatDuration(e.paidMinutes)} paid</span>
        {e.declaredTipsCents > 0 ? <span className="text-muted-foreground">{formatCents(e.declaredTipsCents)} tips</span> : null}
        {e.approvedAt ? <Badge variant="secondary">Approved</Badge> : null}
        {e.flags.map((f) => (
          <span key={f} className={cn("rounded border px-1.5 py-0.5 text-xs font-medium", SEVERITY_TONE[FLAG_META[f].severity])}>
            {FLAG_META[f].label}
          </span>
        ))}
      </div>
      {e.breaks.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Breaks:{" "}
          {e.breaks
            .map(
              (b) =>
                `${formatClock(b.startedAt, tz)} to ${b.endedAt ? formatClock(b.endedAt, tz) : "now"} (${b.paid ? "paid" : "unpaid"})`,
            )
            .join(", ")}
        </p>
      ) : null}
      {e.note ? <p className="mt-1 text-xs">Note: {e.note}</p> : null}
      {e.audit.length > 0 ? (
        <ul className="mt-2 space-y-0.5 border-l-2 border-border pl-2 text-xs text-muted-foreground" data-testid="audit-history">
          {e.audit.map((a) => (
            <li key={a.id}>
              {formatDay(localDateOf(a.at, tz))} {formatClock(a.at, tz)} · {AUDIT_LABEL[a.action] ?? a.action}
              {a.operatorName ? ` by ${a.operatorName}` : ""}
              {a.reason ? `: ${a.reason}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <PunchDialog
          punch={{
            id: e.id,
            employeeId,
            role: e.role,
            clockIn: local(e.clockInAt),
            clockOut: e.clockOutAt ? local(e.clockOutAt) : "",
            breaks: e.breaks.map((b) => ({ start: local(b.startedAt), end: b.endedAt ? local(b.endedAt) : "", paid: b.paid })),
            tipsDollars: (e.declaredTipsCents / 100).toFixed(2),
            note: e.note ?? "",
            approved: e.approvedAt !== null,
          }}
          employees={employees}
          trigger="Edit"
        />
        <form action={deletePunch} className="flex items-center gap-2">
          <input type="hidden" name="entryId" value={e.id} />
          <Input name="reason" required maxLength={500} placeholder="Reason to delete" aria-label="Reason to delete" className="h-7 w-44 text-xs" />
          <ConfirmButton label="Delete" confirmLabel="Confirm delete" size="sm" />
        </form>
      </div>
    </div>
  );
}
