"use client";

import { Delete } from "lucide-react";
import { PIN_LENGTH } from "@/lib/timeclock";
import { cn } from "@/lib/utils";

export function PinPad({
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
        {Array.from({ length: Math.max(PIN_LENGTH.min, pin.length) }, (_, i) => (
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
          disabled={pin.length < PIN_LENGTH.min || busy}
          data-testid="tc-enter"
        >
          {busy ? "…" : "Go"}
        </button>
      </div>
    </div>
  );
}
