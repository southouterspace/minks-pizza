"use client";

import { useState } from "react";
import { formatDuration, formatHours, type KioskView } from "@/lib/timeclock";
import { formatClock } from "@/lib/zoned";
import { formatCents, parseDollars } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ACTION_BUTTON } from "@/components/timeclock/employee-home";
import type { Screen } from "@/components/timeclock/kiosk-flow";

export function ClockOut({
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
  const cents = parseDollars(tips) ?? 0;
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

export function TimeOffForm({
  today,
  busy,
  onBack,
  onSubmit,
}: {
  today: string;
  busy: boolean;
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

export function Done({
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
          <Stat label="This week" value={formatHours(screen.view.week.paidMinutes)} />
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
