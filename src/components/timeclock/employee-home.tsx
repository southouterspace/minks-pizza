"use client";

import { useState } from "react";
import { Coffee, LogIn, LogOut, Play, UtensilsCrossed } from "lucide-react";
import {
  ALLOWED,
  elapsedMinutes,
  formatDuration,
  formatHours,
  REFUSAL_MESSAGE,
  ROLE_LABEL,
  ROLE_TONE,
  type ClockAction,
  type JobRole,
  type KioskShift,
  type KioskView,
} from "@/lib/timeclock";
import { formatClock, formatDay, formatDayRange, localDateOf } from "@/lib/zoned";
import { cn } from "@/lib/utils";

export const ACTION_BUTTON = "flex min-h-20 items-center justify-center gap-3 rounded-2xl px-6 text-2xl font-black disabled:opacity-40";

export function EmployeeHome({
  view,
  tz,
  now,
  busy,
  error,
  onAction,
  onClockOut,
  onTimeOff,
  onDone,
}: {
  view: KioskView;
  tz: string;
  now: Date;
  busy: boolean;
  error: string | null;
  onAction: (action: Exclude<ClockAction, { type: "clock_out" }>) => void;
  /** Clock-out first asks for tips on its own screen. */
  onClockOut: () => void;
  onTimeOff: () => void;
  onDone: () => void;
}) {
  const [role, setRole] = useState<JobRole>(view.defaultRole);
  const { state } = view;
  const allowed = ALLOWED[state.kind];
  const elapsed = (since: string) => formatDuration(elapsedMinutes(new Date(since), now));

  return (
    <div className="w-full max-w-4xl" data-testid="tc-employee">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black">Hi, {view.employee.name.split(" ")[0]}</h1>
          <p className="mt-1 text-lg text-zinc-300" data-testid="tc-state">
            {state.kind === "off"
              ? "You're off the clock."
              : state.kind === "working"
                ? `On the clock since ${formatClock(new Date(state.since), tz)} as ${ROLE_LABEL[state.role]} · ${elapsed(state.since)}`
                : `On a ${state.paid ? "paid" : "unpaid"} break since ${formatClock(new Date(state.since), tz)} · ${elapsed(state.since)}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onDone}
          className="rounded-xl bg-zinc-800 px-5 py-3 text-lg font-bold hover:bg-zinc-700"
          data-testid="tc-done"
        >
          Done
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-4 rounded-xl bg-red-600/20 px-4 py-3 text-lg font-bold text-red-300" data-testid="tc-error">
          {error}
        </p>
      ) : null}

      <section className="mt-6 grid gap-3 sm:grid-cols-2" aria-label="Clock actions">
        {allowed.includes("clock_in") ? (
          <div className="space-y-3 sm:col-span-2">
            {view.employee.roles.length > 1 ? (
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Role">
                {view.employee.roles.map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={role === r}
                    onClick={() => setRole(r)}
                    className={cn(
                      "rounded-xl border-2 px-4 py-3 text-lg font-bold",
                      role === r ? "border-zinc-50 bg-zinc-50 text-zinc-950" : "border-zinc-700 text-zinc-300",
                    )}
                  >
                    {ROLE_LABEL[r]}
                  </button>
                ))}
              </div>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction({ type: "clock_in", role })}
              className={cn(ACTION_BUTTON, "w-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400")}
              data-testid="tc-clock-in"
            >
              <LogIn className="size-7" aria-hidden="true" /> Clock in as {ROLE_LABEL[role]}
            </button>
          </div>
        ) : null}
        {allowed.includes("start_break") ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction({ type: "start_break", paid: false })}
              className={cn(ACTION_BUTTON, "bg-amber-400 text-zinc-950 hover:bg-amber-300")}
              data-testid="tc-break-unpaid"
            >
              <UtensilsCrossed className="size-7" aria-hidden="true" /> Meal break (unpaid)
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction({ type: "start_break", paid: true })}
              className={cn(ACTION_BUTTON, "bg-zinc-800 hover:bg-zinc-700")}
              data-testid="tc-break-paid"
            >
              <Coffee className="size-7" aria-hidden="true" /> Rest break (paid)
            </button>
          </>
        ) : null}
        {allowed.includes("end_break") ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction({ type: "end_break" })}
            className={cn(ACTION_BUTTON, "bg-emerald-500 text-zinc-950 hover:bg-emerald-400 sm:col-span-2")}
            data-testid="tc-end-break"
          >
            <Play className="size-7" aria-hidden="true" /> End break
          </button>
        ) : null}
        {allowed.includes("clock_out") ? (
          <button
            type="button"
            disabled={busy}
            onClick={onClockOut}
            className={cn(ACTION_BUTTON, "bg-red-600 hover:bg-red-500 sm:col-span-2")}
            data-testid="tc-clock-out"
          >
            <LogOut className="size-7" aria-hidden="true" /> Clock out
          </button>
        ) : null}
        {state.kind === "on_break" ? (
          <p className="text-zinc-400 sm:col-span-2">{REFUSAL_MESSAGE.clock_out}</p>
        ) : null}
      </section>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <Panel title="Today">
          {view.todayShifts.length === 0 ? (
            <p className="text-zinc-400">No shift scheduled.</p>
          ) : (
            <ShiftList shifts={view.todayShifts} tz={tz} />
          )}
          {view.current ? (
            <p className="mt-3 text-zinc-300">
              This shift so far: <span className="font-bold text-zinc-50">{formatDuration(view.current.paidMinutes)}</span>
            </p>
          ) : null}
        </Panel>
        <Panel title="This week">
          <p className="text-3xl font-black tabular-nums" data-testid="tc-week-hours">
            {formatHours(view.week.paidMinutes)}
          </p>
          <p className="text-zinc-400">worked so far</p>
          <p className="mt-2 text-zinc-300">
            <span className="font-bold text-zinc-50 tabular-nums">{formatHours(view.week.projectedMinutes)}</span> with your
            remaining shifts
          </p>
        </Panel>
        <Panel title="Time off">
          {view.timeOff.length === 0 ? (
            <p className="text-zinc-400">Nothing requested.</p>
          ) : (
            <ul className="space-y-1" data-testid="tc-time-off-list">
              {view.timeOff.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2">
                  <span>{formatDayRange(t.startDate, t.endDate)}</span>
                  <span
                    className={cn(
                      "rounded px-2 py-0.5 text-xs font-bold uppercase",
                      t.status === "approved" ? "bg-emerald-500 text-zinc-950" : "bg-zinc-700",
                    )}
                  >
                    {t.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={onTimeOff}
            className="mt-3 w-full rounded-xl bg-zinc-800 px-4 py-3 font-bold hover:bg-zinc-700"
            data-testid="tc-request-time-off"
          >
            Request time off
          </button>
        </Panel>
      </div>

      <Panel title="Next 7 days" className="mt-4">
        {view.upcoming.length === 0 ? (
          <p className="text-zinc-400">Nothing scheduled after today.</p>
        ) : (
          <ShiftList shifts={view.upcoming} tz={tz} withDay />
        )}
      </Panel>
    </div>
  );
}

function Panel({ title, className, children }: { title: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={cn("rounded-2xl border border-zinc-800 bg-zinc-900 p-4", className)}>
      <h2 className="mb-2 text-xs font-black tracking-widest text-zinc-400 uppercase">{title}</h2>
      {children}
    </section>
  );
}

function ShiftList({ shifts, tz, withDay }: { shifts: KioskShift[]; tz: string; withDay?: boolean }) {
  return (
    <ul className="space-y-2">
      {shifts.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center gap-2">
          {withDay ? <span className="w-28 font-bold">{formatDay(localDateOf(new Date(s.startsAt), tz))}</span> : null}
          <span className="font-bold tabular-nums">
            {formatClock(new Date(s.startsAt), tz)} to {formatClock(new Date(s.endsAt), tz)}
          </span>
          <span className={cn("rounded border px-2 py-0.5 text-xs font-bold", ROLE_TONE[s.role])}>{ROLE_LABEL[s.role]}</span>
        </li>
      ))}
    </ul>
  );
}
