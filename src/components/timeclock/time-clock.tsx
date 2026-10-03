"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Coffee, Delete, LogIn, LogOut, Play, Users, UtensilsCrossed } from "lucide-react";
import {
  ALLOWED,
  decimalHours,
  formatDuration,
  ROLE_LABEL,
  ROLE_TONE,
  type ClockAction,
  type JobRole,
  type KioskAction,
  type KioskBoard,
  type KioskResponse,
  type KioskShift,
  type KioskView,
  type ShiftSummary,
} from "@/lib/timeclock";
import { formatClock, formatDay, localDateOf } from "@/lib/zoned";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";

const IDLE_MS = 20_000;
const CONFIRM_MS = 4_000;
const BOARD_POLL_MS = 30_000;
const MAX_PIN = 6;

/** The kiosk never keeps an employee signed in: the PIN rides along and is dropped on return to the pad. */
type Screen =
  | { kind: "pad" }
  | { kind: "employee"; pin: string; view: KioskView }
  | { kind: "clock_out"; pin: string; view: KioskView }
  | { kind: "time_off"; pin: string; view: KioskView }
  | { kind: "done"; view: KioskView; message: string; tone: KioskResponse["tone"]; summary: ShiftSummary | null };

type Result = { ok: true; data: KioskResponse } | { ok: false; status: number; code?: string; error: string };

async function send(pin: string, action?: KioskAction): Promise<Result> {
  try {
    const res = await fetch("/api/timeclock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, action }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, code: body.code, error: body.error ?? "Something went wrong." };
    return { ok: true, data: body as KioskResponse };
  } catch {
    return { ok: false, status: 0, error: "Can't reach the server. Check the wifi and try again." };
  }
}

export function TimeClock({ initial, storeName }: { initial: KioskBoard; storeName: string }) {
  const router = useRouter();
  const [board, setBoard] = useState(initial);
  const [offsetMs, setOffsetMs] = useState(() => Date.parse(initial.serverNow) - Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [screen, setScreen] = useState<Screen>({ kind: "pad" });
  const [pin, setPin] = useState("");
  const [padError, setPadError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState(0);
  const busyRef = useRef(false);

  const tz = board.timezone;
  const screenNow = new Date(now + offsetMs);

  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("dark");
    return () => html.classList.remove("dark");
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const refreshBoard = useCallback(async () => {
    try {
      const res = await fetch("/api/timeclock", { cache: "no-store" });
      if (res.status === 401) {
        router.push("/admin/login");
        return;
      }
      if (!res.ok) return;
      const next = (await res.json()) as KioskBoard;
      setOffsetMs(Date.parse(next.serverNow) - Date.now());
      setBoard(next);
    } catch {
      // Offline: the pad keeps working off its last clock reading.
    }
  }, [router]);

  useEffect(() => {
    const t = setInterval(refreshBoard, BOARD_POLL_MS);
    return () => clearInterval(t);
  }, [refreshBoard]);

  const backToPad = useCallback(() => {
    setScreen({ kind: "pad" });
    setPin("");
    void refreshBoard();
  }, [refreshBoard]);

  // Walk-away safety: an idle employee screen returns to the pad.
  useEffect(() => {
    if (screen.kind === "pad") return;
    const t = setTimeout(backToPad, screen.kind === "done" ? CONFIRM_MS : IDLE_MS);
    return () => clearTimeout(t);
  }, [screen, activity, backToPad]);

  const submitPin = useCallback(
    async (value: string) => {
      if (value.length < 4 || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      const result = await send(value);
      busyRef.current = false;
      setBusy(false);
      if (result.ok) {
        setPadError(null);
        setScreen({ kind: "employee", pin: value, view: result.data.view });
        return;
      }
      if (result.code === "signed_out") {
        router.push("/admin/login");
        return;
      }
      setPin("");
      setPadError(result.error);
      setShake((n) => n + 1);
    },
    [router],
  );

  const act = useCallback(
    async (currentPin: string, action: KioskAction) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      const result = await send(currentPin, action);
      busyRef.current = false;
      setBusy(false);
      if (!result.ok) {
        if (result.code === "signed_out") router.push("/admin/login");
        else {
          setPadError(result.error);
          backToPad();
        }
        return;
      }
      const { view, message, tone, summary } = result.data;
      if (tone === "error") {
        setScreen({ kind: "employee", pin: currentPin, view });
        setPadError(message);
        return;
      }
      setPadError(null);
      setScreen({ kind: "done", view, message: message ?? "Saved.", tone, summary });
    },
    [backToPad, router],
  );

  const typeDigit = useCallback((d: string) => {
    setPadError(null);
    setPin((p) => (p.length >= MAX_PIN ? p : p + d));
  }, []);

  // Keyboard on the pad: digits, Backspace, Enter.
  useEffect(() => {
    if (screen.kind !== "pad") return;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key)) typeDigit(e.key);
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Enter") void submitPin(pin);
      else if (e.key === "Escape") setPin("");
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen.kind, pin, submitPin, typeDigit]);

  return (
    <div
      className="flex h-dvh flex-col overflow-hidden bg-zinc-950 text-zinc-50 select-none"
      onPointerDown={() => setActivity((n) => n + 1)}
      onKeyDown={() => setActivity((n) => n + 1)}
    >
      <style>{`
        @keyframes tc-shake { 0%,100% { transform: translateX(0) } 20%,60% { transform: translateX(-12px) } 40%,80% { transform: translateX(12px) } }
        .tc-shake { animation: tc-shake .4s ease-in-out }
      `}</style>

      <header className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-4 py-3">
        <Link
          href="/admin/staff"
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50"
          aria-label="Back to admin"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          <span className="font-semibold">{storeName}</span>
        </Link>
        <span className="ml-auto flex items-center gap-1.5 text-sm text-zinc-400" data-testid="tc-on-clock">
          <Users className="size-4" aria-hidden="true" />
          {board.onClock} on the clock
        </span>
        <span className="text-2xl font-black tabular-nums" suppressHydrationWarning>
          {formatClock(screenNow, tz)}
        </span>
      </header>

      <main className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto p-4">
        {screen.kind === "pad" ? (
          <PinPad
            pin={pin}
            error={padError}
            shake={shake}
            busy={busy}
            date={formatDay(localDateOf(screenNow, tz))}
            onDigit={typeDigit}
            onBackspace={() => setPin((p) => p.slice(0, -1))}
            onSubmit={() => void submitPin(pin)}
          />
        ) : screen.kind === "employee" ? (
          <EmployeeHome
            key={screen.view.employee.id}
            view={screen.view}
            tz={tz}
            now={screenNow}
            busy={busy}
            error={padError}
            onAction={(action) => {
              setPadError(null);
              if (action.type === "clock_out") setScreen({ ...screen, kind: "clock_out" });
              else void act(screen.pin, action);
            }}
            onTimeOff={() => {
              setPadError(null);
              setScreen({ ...screen, kind: "time_off" });
            }}
            onDone={backToPad}
          />
        ) : screen.kind === "clock_out" ? (
          <ClockOut
            view={screen.view}
            tz={tz}
            busy={busy}
            onBack={() => setScreen({ ...screen, kind: "employee" })}
            onConfirm={(declaredTipsCents) => void act(screen.pin, { type: "clock_out", declaredTipsCents })}
          />
        ) : screen.kind === "time_off" ? (
          <TimeOffForm
            today={localDateOf(screenNow, tz)}
            busy={busy}
            error={padError}
            onBack={() => {
              setPadError(null);
              setScreen({ ...screen, kind: "employee" });
            }}
            onSubmit={(startDate, endDate, reason) =>
              void act(screen.pin, { type: "request_time_off", startDate, endDate, reason })
            }
          />
        ) : (
          <Done screen={screen} tz={tz} onDone={backToPad} />
        )}
      </main>
    </div>
  );
}

// --- PIN pad -----------------------------------------------------------------

function PinPad({
  pin,
  error,
  shake,
  busy,
  date,
  onDigit,
  onBackspace,
  onSubmit,
}: {
  pin: string;
  error: string | null;
  shake: number;
  busy: boolean;
  date: string;
  onDigit: (d: string) => void;
  onBackspace: () => void;
  onSubmit: () => void;
}) {
  const key = "flex h-20 items-center justify-center rounded-2xl bg-zinc-900 text-3xl font-black active:bg-zinc-700 hover:bg-zinc-800";
  return (
    <div className="my-auto flex w-full max-w-sm flex-col items-center">
      <p className="text-sm text-zinc-400" suppressHydrationWarning>
        {date}
      </p>
      <h1 className="mt-1 text-2xl font-black">Enter your PIN</h1>
      <div
        key={shake}
        className={cn("mt-6 flex h-12 items-center gap-3", shake > 0 && "tc-shake")}
        data-testid="tc-pin-display"
        aria-label={`${pin.length} digits entered`}
      >
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <span
            key={i}
            className={cn("size-5 rounded-full border-2", i < pin.length ? "border-zinc-50 bg-zinc-50" : "border-zinc-600")}
          />
        ))}
      </div>
      <p role="alert" className="mt-2 h-6 text-base font-bold text-red-400" data-testid="tc-pad-error">
        {error}
      </p>
      <div className="mt-4 grid w-full grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" className={key} onClick={() => onDigit(d)} data-testid={`tc-key-${d}`}>
            {d}
          </button>
        ))}
        <button type="button" className={cn(key, "text-zinc-400")} onClick={onBackspace} aria-label="Delete digit">
          <Delete className="size-8" />
        </button>
        <button type="button" className={key} onClick={() => onDigit("0")} data-testid="tc-key-0">
          0
        </button>
        <button
          type="button"
          className={cn(key, "bg-emerald-500 text-xl text-zinc-950 hover:bg-emerald-400 disabled:opacity-40")}
          onClick={onSubmit}
          disabled={pin.length < 4 || busy}
          data-testid="tc-enter"
        >
          {busy ? "…" : "Go"}
        </button>
      </div>
    </div>
  );
}

// --- employee home -------------------------------------------------------------

const ACTION_BUTTON = "flex min-h-20 items-center justify-center gap-3 rounded-2xl px-6 text-2xl font-black disabled:opacity-40";

function EmployeeHome({
  view,
  tz,
  now,
  busy,
  error,
  onAction,
  onTimeOff,
  onDone,
}: {
  view: KioskView;
  tz: string;
  now: Date;
  busy: boolean;
  error: string | null;
  onAction: (action: ClockAction) => void;
  onTimeOff: () => void;
  onDone: () => void;
}) {
  const [role, setRole] = useState<JobRole>(view.defaultRole);
  const { state } = view;
  const allowed = ALLOWED[state.kind];
  const elapsed = (since: string) => formatDuration(Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / 60_000)));

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
              disabled={busy || view.employee.roles.length === 0}
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
            onClick={() => onAction({ type: "clock_out", declaredTipsCents: 0 })}
            className={cn(ACTION_BUTTON, "bg-red-600 hover:bg-red-500 sm:col-span-2")}
            data-testid="tc-clock-out"
          >
            <LogOut className="size-7" aria-hidden="true" /> Clock out
          </button>
        ) : null}
        {state.kind === "on_break" ? (
          <p className="text-zinc-400 sm:col-span-2">End your break before clocking out.</p>
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
            {decimalHours(view.week.paidMinutes)} h
          </p>
          <p className="text-zinc-400">worked so far</p>
          <p className="mt-2 text-zinc-300">
            <span className="font-bold text-zinc-50 tabular-nums">{decimalHours(view.week.projectedMinutes)} h</span> with your
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
                  <span>{t.startDate === t.endDate ? formatDay(t.startDate) : `${formatDay(t.startDate)} to ${formatDay(t.endDate)}`}</span>
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
          <p className="text-zinc-400">No published shifts yet.</p>
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

// --- clock out, time off, confirmation ---------------------------------------------

function ClockOut({
  view,
  tz,
  busy,
  onBack,
  onConfirm,
}: {
  view: KioskView;
  tz: string;
  busy: boolean;
  onBack: () => void;
  onConfirm: (declaredTipsCents: number) => void;
}) {
  const [tips, setTips] = useState("");
  const cents = Math.max(0, Math.round((Number.parseFloat(tips) || 0) * 100));
  const since = view.state.kind === "working" ? formatClock(new Date(view.state.since), tz) : null;
  return (
    <form
      className="my-auto w-full max-w-md space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm(cents);
      }}
    >
      <h1 className="text-3xl font-black">Clock out</h1>
      {since && view.current ? (
        <p className="text-lg text-zinc-300">
          In since {since} · {formatDuration(view.current.paidMinutes)} paid so far
        </p>
      ) : null}
      <label className="block">
        <span className="text-lg font-bold">Cash tips to declare (optional)</span>
        <span className="mt-2 flex items-center rounded-2xl border-2 border-zinc-700 bg-zinc-900 px-4 focus-within:border-zinc-50">
          <span className="text-3xl font-black text-zinc-400">$</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={tips}
            onChange={(e) => setTips(e.target.value)}
            placeholder="0.00"
            className="h-16 w-full bg-transparent px-2 text-3xl font-black tabular-nums outline-none"
            data-testid="tc-tips"
          />
        </span>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={onBack} className={cn(ACTION_BUTTON, "bg-zinc-800 text-xl hover:bg-zinc-700")}>
          Back
        </button>
        <button
          type="submit"
          disabled={busy}
          className={cn(ACTION_BUTTON, "bg-red-600 text-xl hover:bg-red-500")}
          data-testid="tc-confirm-clock-out"
        >
          Clock out
        </button>
      </div>
    </form>
  );
}

function TimeOffForm({
  today,
  busy,
  error,
  onBack,
  onSubmit,
}: {
  today: string;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onSubmit: (startDate: string, endDate: string, reason: string) => void;
}) {
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [reason, setReason] = useState("");
  const input = "mt-2 h-14 w-full rounded-xl border-2 border-zinc-700 bg-zinc-900 px-3 text-xl outline-none focus:border-zinc-50 [color-scheme:dark]";
  return (
    <form
      className="my-auto w-full max-w-md space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(start, end < start ? start : end, reason.trim());
      }}
    >
      <h1 className="text-3xl font-black">Request time off</h1>
      {error ? (
        <p role="alert" className="rounded-xl bg-red-600/20 px-4 py-3 font-bold text-red-300">
          {error}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <label className="block font-bold">
          First day
          <input type="date" required min={today} value={start} onChange={(e) => setStart(e.target.value)} className={input} data-testid="tc-off-start" />
        </label>
        <label className="block font-bold">
          Last day
          <input type="date" required min={start} value={end} onChange={(e) => setEnd(e.target.value)} className={input} data-testid="tc-off-end" />
        </label>
      </div>
      <label className="block font-bold">
        Reason (optional)
        <input type="text" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className={input} data-testid="tc-off-reason" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={onBack} className={cn(ACTION_BUTTON, "bg-zinc-800 text-xl hover:bg-zinc-700")}>
          Back
        </button>
        <button
          type="submit"
          disabled={busy}
          className={cn(ACTION_BUTTON, "bg-emerald-500 text-xl text-zinc-950 hover:bg-emerald-400")}
          data-testid="tc-off-submit"
        >
          Send request
        </button>
      </div>
    </form>
  );
}

function Done({
  screen,
  tz,
  onDone,
}: {
  screen: Extract<Screen, { kind: "done" }>;
  tz: string;
  onDone: () => void;
}) {
  const { summary } = screen;
  return (
    <button
      type="button"
      onClick={onDone}
      className="my-auto flex w-full max-w-lg flex-col items-center rounded-3xl bg-zinc-900 p-8 text-center"
      data-testid="tc-confirmation"
    >
      <span
        className={cn("text-3xl font-black", screen.tone === "success" ? "text-emerald-400" : "text-zinc-50")}
        data-testid="tc-message"
      >
        {screen.message}
      </span>
      <span className="mt-2 text-lg text-zinc-300">{screen.view.employee.name}</span>
      {summary ? (
        <span className="mt-6 grid w-full grid-cols-2 gap-3 text-left" data-testid="tc-summary">
          <Stat label="In" value={formatClock(new Date(summary.clockInAt), tz)} />
          <Stat label="Out" value={formatClock(new Date(summary.clockOutAt), tz)} />
          <Stat label="Paid time" value={formatDuration(summary.paidMinutes)} />
          <Stat label="Unpaid breaks" value={formatDuration(summary.breakMinutes)} />
          <Stat label="Tips declared" value={formatCents(summary.declaredTipsCents)} />
          <Stat label="This week" value={`${decimalHours(screen.view.week.paidMinutes)} h`} />
        </span>
      ) : null}
      <span className="mt-6 text-sm text-zinc-500">Tap to finish</span>
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-xl bg-zinc-800 px-3 py-2">
      <span className="block text-xs font-bold tracking-wide text-zinc-400 uppercase">{label}</span>
      <span className="block text-xl font-black tabular-nums">{value}</span>
    </span>
  );
}
