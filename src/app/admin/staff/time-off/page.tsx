import type { Metadata } from "next";
import { and, asc, desc, eq, gte, isNotNull, lt, ne } from "drizzle-orm";
import { db, employees, shifts, timeOffRequests } from "@/db";
import { requireOperator } from "@/lib/auth";
import { decideTimeOffRequest } from "@/app/admin/staff/actions";
import { ROLE_LABEL } from "@/lib/timeclock";
import { getStaffConfig } from "@/lib/staff/config";
import { addDays, formatClock, formatDay, localDateOf, zonedInstant, type LocalDate } from "@/lib/zoned";
import { AddTimeOffForm } from "@/components/staff/add-time-off-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Time off" };

const range = (start: LocalDate, end: LocalDate) => (start === end ? formatDay(start) : `${formatDay(start)} to ${formatDay(end)}`);

export default async function TimeOffPage() {
  await requireOperator();
  const { timezone: tz } = await getStaffConfig();
  const today = localDateOf(new Date(), tz);
  const recentSince = zonedInstant(addDays(today, -30), "00:00", tz);

  const request = {
    id: timeOffRequests.id,
    employeeId: timeOffRequests.employeeId,
    name: employees.name,
    startDate: timeOffRequests.startDate,
    endDate: timeOffRequests.endDate,
    reason: timeOffRequests.reason,
    status: timeOffRequests.status,
    source: timeOffRequests.source,
    createdAt: timeOffRequests.createdAt,
    decidedAt: timeOffRequests.decidedAt,
  };
  const [pending, upcoming, decided, people] = await Promise.all([
    db
      .select(request)
      .from(timeOffRequests)
      .innerJoin(employees, eq(employees.id, timeOffRequests.employeeId))
      .where(eq(timeOffRequests.status, "pending"))
      .orderBy(asc(timeOffRequests.startDate)),
    db
      .select(request)
      .from(timeOffRequests)
      .innerJoin(employees, eq(employees.id, timeOffRequests.employeeId))
      .where(and(eq(timeOffRequests.status, "approved"), gte(timeOffRequests.endDate, today)))
      .orderBy(asc(timeOffRequests.startDate)),
    db
      .select(request)
      .from(timeOffRequests)
      .innerJoin(employees, eq(employees.id, timeOffRequests.employeeId))
      .where(and(ne(timeOffRequests.status, "pending"), isNotNull(timeOffRequests.decidedAt), gte(timeOffRequests.decidedAt, recentSince)))
      .orderBy(desc(timeOffRequests.decidedAt))
      .limit(20),
    db.select({ id: employees.id, name: employees.name }).from(employees).where(eq(employees.isActive, true)).orderBy(asc(employees.name)),
  ]);

  const conflicts = await Promise.all(
    pending.map((r) =>
      db
        .select({ id: shifts.id, role: shifts.role, startsAt: shifts.startsAt, endsAt: shifts.endsAt, publishedAt: shifts.publishedAt })
        .from(shifts)
        .where(
          and(
            eq(shifts.employeeId, r.employeeId),
            lt(shifts.startsAt, zonedInstant(addDays(r.endDate, 1), "00:00", tz)),
            gte(shifts.endsAt, zonedInstant(r.startDate, "00:00", tz)),
          ),
        )
        .orderBy(asc(shifts.startsAt)),
    ),
  );

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Time off</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Staff request time off at the time clock. Approved time off shows on the schedule and warns on any shift that
        lands on it.
      </p>

      <h2 className="mt-8 text-sm font-semibold">Pending ({pending.length})</h2>
      {pending.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nothing waiting for a decision.</p>
      ) : (
        <Card className="mt-2 gap-0! py-0!">
          {pending.map((r, i) => (
            <div
              key={r.id}
              data-testid="time-off-pending"
              className={cn("flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-4", i > 0 && "border-t border-border")}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {r.name} · {range(r.startDate, r.endDate)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {r.reason ?? "No reason given"} · requested {formatDay(localDateOf(r.createdAt, tz))}
                </p>
                {conflicts[i].length > 0 ? (
                  <ul className="mt-1 text-sm text-warning">
                    {conflicts[i].map((s) => (
                      <li key={s.id}>
                        Scheduled {formatDay(localDateOf(s.startsAt, tz))} {formatClock(s.startsAt, tz)} to{" "}
                        {formatClock(s.endsAt, tz)} as {ROLE_LABEL[s.role]}
                        {s.publishedAt ? "" : " (draft)"}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">No shifts scheduled on these days.</p>
                )}
              </div>
              <form action={decideTimeOffRequest} className="flex gap-2">
                <input type="hidden" name="requestId" value={r.id} />
                <Button type="submit" name="decision" value="approved" size="sm" data-testid="approve-time-off">
                  Approve
                </Button>
                <Button type="submit" name="decision" value="denied" size="sm" variant="outline">
                  Deny
                </Button>
              </form>
            </div>
          ))}
        </Card>
      )}

      <h2 className="mt-8 text-sm font-semibold">Add time off</h2>
      <p className="mt-1 text-sm text-muted-foreground">For someone who asked in person. It&apos;s approved right away.</p>
      <div className="mt-3">
        <AddTimeOffForm employees={people} today={today} />
      </div>

      <div className="mt-8 grid gap-8 md:grid-cols-2">
        <section>
          <h2 className="text-sm font-semibold">Upcoming approved</h2>
          {upcoming.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm" data-testid="time-off-upcoming">
              {upcoming.map((r) => (
                <li key={r.id}>
                  <span className="font-medium">{r.name}</span> · {range(r.startDate, r.endDate)}
                  {r.reason ? <span className="text-muted-foreground"> · {r.reason}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h2 className="text-sm font-semibold">Recently decided</h2>
          {decided.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">None in the last 30 days.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {decided.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.name}</span> · {range(r.startDate, r.endDate)}
                  <Badge variant={r.status === "approved" ? "secondary" : "outline"}>
                    {r.status === "approved" ? "Approved" : "Denied"}
                  </Badge>
                  {r.source === "manager" ? <span className="text-xs text-muted-foreground">added by a manager</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
