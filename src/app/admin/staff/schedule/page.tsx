import type { Metadata } from "next";
import { Plus, TriangleAlert } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import { copyLastWeek, publishSchedule } from "@/app/admin/staff/actions";
import { formatCents } from "@/lib/money";
import {
  CONFLICT_LABEL,
  decimalHours,
  ROLE_LABEL,
  ROLE_TONE,
} from "@/lib/timeclock";
import { getStaffConfig, resolveWeek } from "@/lib/staff/config";
import { getScheduleWeek, type ScheduleShift, type ScheduleWeek } from "@/lib/staff/schedule";
import { dayOfWeek, formatDay, localDateOf, type LocalDate } from "@/lib/zoned";
import { ShiftDialog, type ShiftDialogEmployee } from "@/components/staff/shift-dialog";
import { WeekNav } from "@/components/staff/week-nav";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Schedule" };

/** "16:30" → "4:30p" */
function shortClock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m === 0 ? "" : `:${String(m).padStart(2, "0")}`}${h < 12 ? "a" : "p"}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default async function SchedulePage({ searchParams }: PageProps<"/admin/staff/schedule">) {
  await requireOperator();
  const params = await searchParams;
  const cfg = await getStaffConfig();
  const thisWeek = resolveWeek(undefined, cfg);
  const weekStart = resolveWeek(params.week, cfg);
  const week = await getScheduleWeek(weekStart, cfg);
  const today = localDateOf(new Date(), cfg.timezone);

  const dialogEmployees: ShiftDialogEmployee[] = week.employees.map((e) => ({
    id: e.id,
    name: e.name,
    roles: e.roles.map((r) => r.role),
    primary: e.roles.find((r) => r.isPrimary)?.role ?? null,
  }));
  const rows: { id: number | null; name: string }[] = [...week.employees, { id: null, name: "Open shifts" }];
  const totalMinutes = week.days.reduce((n, d) => n + d.minutes, 0);
  const totalCost = week.days.reduce((n, d) => n + d.costCents, 0);
  const notice =
    params.copied !== undefined
      ? `Copied ${plural(Number(params.copied), "shift")} from last week as drafts.`
      : params.published !== undefined
        ? `Published ${plural(Number(params.published), "shift")}. Staff can see them on the time clock.`
        : null;

  return (
    <div data-wide>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Schedule</h1>
        <div className="flex flex-wrap items-center gap-2">
          <form action={copyLastWeek}>
            <input type="hidden" name="week" value={weekStart} />
            <Button type="submit" variant="outline" size="sm">
              Copy last week
            </Button>
          </form>
          <form action={publishSchedule}>
            <input type="hidden" name="week" value={weekStart} />
            <Button type="submit" size="sm" disabled={week.drafts === 0} data-testid="publish-week">
              {week.drafts === 0 ? "All published" : `Publish ${plural(week.drafts, "change")}`}
            </Button>
          </form>
        </div>
      </div>
      <div className="mt-3">
        <WeekNav path="/admin/staff/schedule" weekStart={weekStart} thisWeek={thisWeek} />
      </div>
      {notice ? (
        <p role="status" className="mt-3 text-sm font-medium text-success">
          {notice}
        </p>
      ) : null}

      <Card className="mt-4 gap-0! overflow-x-auto py-0!">
        <table className="w-full min-w-[960px] border-collapse text-sm" data-testid="schedule-grid">
          <thead>
            <tr className="border-b border-border">
              <th className="sticky left-0 z-10 w-28 bg-card px-3 py-2 text-left font-medium sm:w-40">Employee</th>
              {week.dates.map((date) => (
                <th
                  key={date}
                  className={cn("px-2 py-2 text-left font-medium", date === today && "text-primary underline underline-offset-4")}
                >
                  {formatDay(date)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const person = week.employees.find((e) => e.id === row.id);
              const overtime = person !== undefined && person.weekMinutes > cfg.rules.otWeeklyMinutes;
              return (
                <tr key={row.id ?? "open"} className="border-b border-border align-top" data-testid="schedule-row">
                  <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-normal">
                    <span className={cn("block font-medium", row.id === null && "text-muted-foreground")}>{row.name}</span>
                    {person ? (
                      <span className={cn("text-xs tabular-nums", overtime ? "font-medium text-destructive" : "text-muted-foreground")}>
                        {decimalHours(person.weekMinutes)} h{overtime ? " · overtime" : ""}
                      </span>
                    ) : null}
                  </th>
                  {week.dates.map((date) => (
                    <Cell key={date} week={week} date={date} employeeId={row.id} employees={dialogEmployees} />
                  ))}
                </tr>
              );
            })}
          </tbody>
          <tfoot className="text-xs">
            <FooterRow label="Scheduled" total={`${decimalHours(totalMinutes)} h`}>
              {week.days.map((d) => `${decimalHours(d.minutes)} h`)}
            </FooterRow>
            <FooterRow label="Labor cost" total={formatCents(totalCost)}>
              {week.days.map((d) => formatCents(d.costCents))}
            </FooterRow>
            <FooterRow label="Forecast sales">
              {week.days.map((d) => (d.forecastCents === null ? "No history" : formatCents(d.forecastCents)))}
            </FooterRow>
            <FooterRow label="Labor %">
              {week.days.map((d) =>
                d.forecastCents === null || d.forecastCents === 0 ? "–" : `${((d.costCents / d.forecastCents) * 100).toFixed(1)}%`,
              )}
            </FooterRow>
          </tfoot>
        </table>
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">
        Forecast is the average subtotal of the same weekday over the previous four weeks. Labor cost uses each
        person&apos;s rate for the shift&apos;s role; open shifts aren&apos;t priced.
      </p>
    </div>
  );
}

function FooterRow({ label, total, children }: { label: string; total?: string; children: string[] }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <th className="sticky left-0 z-10 bg-card px-3 py-1.5 text-left font-medium">
        {label}
        {total ? <span className="ml-1 font-normal text-muted-foreground tabular-nums">{total}</span> : null}
      </th>
      {children.map((value, i) => (
        <td key={i} className="px-2 py-1.5 text-muted-foreground tabular-nums">
          {value}
        </td>
      ))}
    </tr>
  );
}

function Cell({
  week,
  date,
  employeeId,
  employees,
}: {
  week: ScheduleWeek;
  date: LocalDate;
  employeeId: number | null;
  employees: ShiftDialogEmployee[];
}) {
  const shifts = week.shifts.filter((s) => s.employeeId === employeeId && s.date === date);
  const off = employeeId === null ? [] : week.timeOff.filter((t) => t.employeeId === employeeId && t.startDate <= date && t.endDate >= date);
  const approvedOff = off.find((t) => t.status === "approved");
  const person = week.employees.find((e) => e.id === employeeId);
  const availability = person ? person.availability[dayOfWeek(date)] : null;
  const cellId = `${employeeId ?? "open"}-${date}`;

  return (
    <td
      className={cn(
        "min-w-28 px-1.5 py-1.5",
        approvedOff && "bg-[repeating-linear-gradient(135deg,var(--muted)_0_6px,transparent_6px_12px)]",
      )}
      data-testid={`schedule-cell-${cellId}`}
    >
      <div className="flex flex-col gap-1">
        {approvedOff ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium" data-testid="time-off-label">
            Time off{approvedOff.reason ? `: ${approvedOff.reason}` : ""}
          </span>
        ) : off.length > 0 ? (
          <span className="text-xs text-warning">Time off requested</span>
        ) : null}
        {availability?.kind === "none" ? <span className="text-xs text-muted-foreground">Unavailable</span> : null}
        {availability?.kind === "window" ? (
          <span className="text-xs text-muted-foreground">
            Available {shortClock(availability.from)}–{shortClock(availability.to)}
          </span>
        ) : null}
        {shifts.map((s) => (
          <ShiftChip key={s.id} shift={s} employees={employees} />
        ))}
        <ShiftDialog
          shift={{
            id: null,
            employeeId,
            role: null,
            date,
            start: "16:00",
            end: "22:00",
            unpaidBreakMinutes: 0,
            notes: null,
          }}
          employees={employees}
          triggerClassName="flex h-6 w-full items-center justify-center rounded text-muted-foreground opacity-60 hover:bg-muted hover:opacity-100"
          triggerLabel={`Add shift on ${formatDay(date)}`}
          testId={`add-shift-${cellId}`}
          trigger={<Plus className="size-3.5" aria-hidden="true" />}
        />
      </div>
    </td>
  );
}

function ShiftChip({ shift, employees }: { shift: ScheduleShift; employees: ShiftDialogEmployee[] }) {
  return (
    <ShiftDialog
      shift={{
        id: shift.id,
        employeeId: shift.employeeId,
        role: shift.role,
        date: shift.date,
        start: shift.start,
        end: shift.end,
        unpaidBreakMinutes: shift.unpaidBreakMinutes,
        notes: shift.notes,
      }}
      employees={employees}
      testId="shift-chip"
      triggerClassName={cn(
        "w-full rounded border px-1.5 py-1 text-left text-xs",
        ROLE_TONE[shift.role],
        !shift.published && "border-dashed opacity-75",
      )}
      trigger={
        <>
          <span className="flex items-center justify-between gap-1 font-semibold tabular-nums">
            {shortClock(shift.start)}–{shortClock(shift.end)}
            {shift.conflicts.length > 0 ? <TriangleAlert className="size-3.5 text-destructive" aria-hidden="true" /> : null}
          </span>
          <span className="block truncate">
            {ROLE_LABEL[shift.role]}
            {shift.published ? "" : " · Draft"}
          </span>
          {shift.conflicts.map((c) => (
            <span key={c} className="block font-medium text-destructive" data-testid="shift-conflict">
              {CONFLICT_LABEL[c]}
            </span>
          ))}
        </>
      }
    />
  );
}
