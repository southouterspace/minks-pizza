import type { Metadata } from "next";
import Link from "next/link";
import { requireOperator } from "@/lib/auth";
import { clockOutForEmployee } from "@/app/admin/staff/actions";
import { formatCents } from "@/lib/money";
import { decimalHours, FLAG_META, formatDuration, ROLE_LABEL } from "@/lib/timeclock";
import { getStaffConfig } from "@/lib/staff/config";
import { getOverview } from "@/lib/staff/overview";
import { addDays, formatClock, localDateOf, weekStartOf } from "@/lib/zoned";
import { AutoRefresh } from "@/components/admin/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Staff" };

export default async function StaffOverviewPage() {
  await requireOperator();
  const cfg = await getStaffConfig();
  const tz = cfg.timezone;
  const data = await getOverview(cfg);
  const lastWeek = addDays(weekStartOf(localDateOf(new Date(), tz), cfg.rules.weekStartsOn), -7);
  const flagTotal = data.attention.flags.reduce((n, f) => n + f.count, 0);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Staff overview</h1>
        <AutoRefresh intervalMs={30_000} />
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Stat label="On the clock" value={String(data.onClock.length)} />
        <Stat
          label="Labor today"
          value={data.today.laborPercent === null ? "–" : `${data.today.laborPercent.toFixed(1)}%`}
          detail={`${formatCents(data.today.laborCents)} labor on ${formatCents(data.today.salesCents)} sales`}
          testId="labor-percent"
        />
        <Stat
          label="This week"
          value={`${decimalHours(data.week.actualMinutes)} h`}
          detail={`worked of ${decimalHours(data.week.scheduledMinutes)} h scheduled`}
        />
      </div>

      <Section title="On the clock now">
        {data.onClock.length === 0 ? (
          <Empty>Nobody is clocked in.</Empty>
        ) : (
          <Card className="gap-0! py-0!">
            {data.onClock.map((row, i) => (
              <div
                key={row.entryId}
                data-testid="on-clock-row"
                className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3", i > 0 && "border-t border-border")}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {row.employeeName}
                    {row.onBreak ? <Badge variant="secondary">On break</Badge> : null}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {ROLE_LABEL[row.role]} · since {formatClock(row.since, tz)} · {formatDuration(row.paidMinutes)}
                  </p>
                </div>
                <form action={clockOutForEmployee} className="flex items-center gap-2">
                  <input type="hidden" name="entryId" value={row.entryId} />
                  <Input
                    name="reason"
                    required
                    maxLength={500}
                    placeholder="Reason"
                    aria-label={`Reason to clock out ${row.employeeName}`}
                    className="h-7 w-40 text-xs"
                  />
                  <Button type="submit" variant="outline" size="sm">
                    Clock out
                  </Button>
                </form>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <div className="grid gap-x-8 md:grid-cols-2">
        <Section title="Late or no-show">
          {data.late.length === 0 ? (
            <Empty>Everyone scheduled so far has clocked in.</Empty>
          ) : (
            <ul className="space-y-1 text-sm" data-testid="late-list">
              {data.late.map((l) => (
                <li key={l.shiftId}>
                  <span className="font-medium text-warning">{l.employeeName}</span> · {ROLE_LABEL[l.role]} shift at{" "}
                  {formatClock(l.startsAt, tz)}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Overtime risk this week">
          {data.week.otRisk.length === 0 ? (
            <Empty>Nobody is projected near {decimalHours(cfg.rules.otWeeklyMinutes)} h.</Empty>
          ) : (
            <ul className="space-y-1 text-sm">
              {data.week.otRisk.map((r) => (
                <li key={r.employeeId}>
                  <span className="font-medium">{r.name}</span> · {decimalHours(r.projectedMinutes)} h projected
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="Needs attention">
        <ul className="space-y-1 text-sm">
          <li>
            <Link href="/admin/staff/timesheets" className="hover:underline">
              {flagTotal === 0
                ? "No timesheet exceptions this week."
                : data.attention.flags.map((f) => `${f.count} ${FLAG_META[f.flag].label.toLowerCase()}`).join(" · ")}
            </Link>
          </li>
          <li>
            <Link href="/admin/staff/time-off" className={cn("hover:underline", data.attention.pendingTimeOff > 0 && "font-medium text-warning")}>
              {data.attention.pendingTimeOff} time-off {data.attention.pendingTimeOff === 1 ? "request" : "requests"} pending
            </Link>
          </li>
          <li>
            <Link
              href={`/admin/staff/timesheets?week=${lastWeek}`}
              className={cn("hover:underline", data.attention.unapprovedLastWeek > 0 && "font-medium text-warning")}
            >
              {data.attention.unapprovedLastWeek} unapproved {data.attention.unapprovedLastWeek === 1 ? "punch" : "punches"} from
              last week
            </Link>
          </li>
        </ul>
      </Section>
    </div>
  );
}

function Stat({ label, value, detail, testId }: { label: string; value: string; detail?: string; testId?: string }) {
  return (
    <Card className="gap-1! px-5 py-4!">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums" data-testid={testId}>
        {value}
      </p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
