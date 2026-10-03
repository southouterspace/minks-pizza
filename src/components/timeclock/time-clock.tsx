"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Users } from "lucide-react";
import { PIN_LENGTH, type KioskAction, type KioskBoard, type KioskResponse } from "@/lib/timeclock";
import { formatClock, formatDay, localDateOf } from "@/lib/zoned";
import { EmployeeHome } from "@/components/timeclock/employee-home";
import { ClockOut, Done, TimeOffForm } from "@/components/timeclock/kiosk-forms";
import { kioskReducer, PAD, SCREEN_TIMEOUT_MS, type KioskResult } from "@/components/timeclock/kiosk-flow";
import { PinPad } from "@/components/timeclock/pin-pad";

const BOARD_POLL_MS = 30_000;

async function send(pin: string, action?: KioskAction): Promise<KioskResult> {
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
  const [screen, dispatch] = useReducer(kioskReducer, PAD);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState(0);
  const inFlight = useRef(false);

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

  const backToPad = useCallback(
    (error?: string) => {
      dispatch({ type: "reset", error });
      void refreshBoard();
    },
    [refreshBoard],
  );

  useEffect(() => {
    const ms = SCREEN_TIMEOUT_MS[screen.kind];
    if (ms === null) return;
    const t = setTimeout(() => backToPad(), ms);
    return () => clearTimeout(t);
  }, [screen, activity, backToPad]);

  /** One request at a time; a signed-out tablet goes to the login page instead of a screen. */
  const request = useCallback(
    async (pin: string, action?: KioskAction) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      const result = await send(pin, action);
      inFlight.current = false;
      setBusy(false);
      if (!result.ok && result.code === "signed_out") {
        router.push("/admin/login");
        return;
      }
      if (!action) dispatch({ type: "pin_result", pin, result });
      else if (result.ok) dispatch({ type: "action_result", pin, result });
      else backToPad(result.error);
    },
    [backToPad, router],
  );

  const digits = screen.kind === "pad" ? screen.digits : "";
  const submitPin = useCallback(() => {
    if (digits.length >= PIN_LENGTH.min) void request(digits);
  }, [digits, request]);

  useEffect(() => {
    if (screen.kind !== "pad") return;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key)) dispatch({ type: "digit", digit: e.key });
      else if (e.key === "Backspace") dispatch({ type: "backspace" });
      else if (e.key === "Enter") submitPin();
      else if (e.key === "Escape") dispatch({ type: "clear" });
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen.kind, submitPin]);

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
          <span className="hidden font-semibold sm:inline">{storeName}</span>
        </Link>
        <span className="ml-auto flex items-center gap-1.5 text-sm whitespace-nowrap text-zinc-400" data-testid="tc-on-clock">
          <Users className="size-4" aria-hidden="true" />
          {board.onClock} on the clock
        </span>
        <span className="text-2xl font-black whitespace-nowrap tabular-nums" suppressHydrationWarning>
          {formatClock(screenNow, tz)}
        </span>
      </header>

      <main className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto p-4">
        {screen.kind === "pad" ? (
          <PinPad
            pin={screen.digits}
            error={screen.error}
            shake={screen.shake}
            busy={busy}
            date={formatDay(localDateOf(screenNow, tz))}
            onDigit={(digit) => dispatch({ type: "digit", digit })}
            onBackspace={() => dispatch({ type: "backspace" })}
            onSubmit={submitPin}
          />
        ) : screen.kind === "employee" ? (
          <EmployeeHome
            key={screen.view.employee.id}
            view={screen.view}
            tz={tz}
            now={screenNow}
            busy={busy}
            error={screen.error}
            onAction={(action) => void request(screen.pin, action)}
            onClockOut={() => dispatch({ type: "goto", to: "clock_out" })}
            onTimeOff={() => dispatch({ type: "goto", to: "time_off" })}
            onDone={() => backToPad()}
          />
        ) : screen.kind === "clock_out" ? (
          <ClockOut
            view={screen.view}
            tz={tz}
            busy={busy}
            onBack={() => dispatch({ type: "goto", to: "employee" })}
            onConfirm={(declaredTipsCents) => void request(screen.pin, { type: "clock_out", declaredTipsCents })}
          />
        ) : screen.kind === "time_off" ? (
          <TimeOffForm
            today={localDateOf(screenNow, tz)}
            busy={busy}
            onBack={() => dispatch({ type: "goto", to: "employee" })}
            onSubmit={(startDate, endDate, reason) =>
              void request(screen.pin, { type: "request_time_off", startDate, endDate, reason })
            }
          />
        ) : (
          <Done screen={screen} tz={tz} onDone={() => backToPad()} />
        )}
      </main>
    </div>
  );
}
