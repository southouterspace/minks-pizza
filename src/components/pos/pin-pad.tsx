"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Delete, Lock, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"] as const;

/**
 * Four digits, big keys, and the keyboard's digits while `active`. Calls
 * `onComplete` on the fourth digit and clears itself for the next try.
 */
export function PinPad({
  onComplete,
  error,
  busy,
  active = true,
}: {
  onComplete: (pin: string) => void;
  error: string | null;
  busy: boolean;
  active?: boolean;
}) {
  const [pin, setPinState] = useState("");
  // Keys can arrive faster than renders; the ref is the source of truth.
  const pinRef = useRef("");
  const setPin = (p: string) => {
    pinRef.current = p;
    setPinState(p);
  };

  const press = useCallback(
    (key: (typeof KEYS)[number]) => {
      if (busy) return;
      if (key === "clear") return setPin("");
      if (key === "back") return setPin(pinRef.current.slice(0, -1));
      const next = (pinRef.current + key).slice(0, 4);
      if (next.length === 4) {
        setPin("");
        onComplete(next);
      } else {
        setPin(next);
      }
    },
    [busy, onComplete],
  );

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key as (typeof KEYS)[number]);
      else if (e.key === "Backspace") press("back");
      else if (e.key === "Escape") press("clear");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, press]);

  return (
    <div className="flex w-72 flex-col items-center gap-5">
      <div className="flex gap-4" aria-label={`${pin.length} of 4 digits entered`}>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn(
              "size-4 rounded-full border-2 border-foreground/60 transition-colors",
              i < pin.length && "bg-foreground",
              busy && "animate-pulse",
            )}
          />
        ))}
      </div>
      <p role="alert" className={cn("h-5 text-sm font-medium text-destructive", !error && "invisible")}>
        {error ?? "."}
      </p>
      <div className="grid w-full grid-cols-3 gap-3">
        {KEYS.map((key) => (
          <button
            key={key}
            type="button"
            data-pin-key={key}
            onClick={() => press(key)}
            className={cn(
              "flex h-16 items-center justify-center rounded-2xl text-2xl font-semibold transition-colors select-none active:scale-95",
              key === "clear" || key === "back"
                ? "text-base text-muted-foreground hover:bg-muted"
                : "bg-muted hover:bg-muted/70",
            )}
            aria-label={key === "back" ? "Delete digit" : key === "clear" ? "Clear" : key}
          >
            {key === "back" ? <Delete className="size-6" /> : key === "clear" ? "Clear" : key}
          </button>
        ))}
      </div>
    </div>
  );
}

export function LockScreen({
  storeName,
  lastName,
  onPin,
}: {
  storeName: string;
  lastName: string | null;
  onPin: (pin: string) => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);

  const submit = useCallback(
    async (pin: string) => {
      setBusy(true);
      setError(await onPin(pin));
      setBusy(false);
    },
    [onPin],
  );

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background" data-testid="lock-screen">
      <div className="flex flex-col items-center gap-6">
        <div className="text-center">
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Lock className="size-4" /> {storeName} · Counter
          </p>
          <p className="mt-1 text-4xl font-semibold tabular-nums">
            {now?.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) ?? " "}
          </p>
          <p className="mt-3 text-lg">Enter your PIN</p>
          {lastName && <p className="text-sm text-muted-foreground">Last signed in: {lastName}</p>}
        </div>
        <PinPad onComplete={submit} error={error} busy={busy} />
      </div>
    </div>
  );
}

export function ManagerPinDialog({
  open,
  label,
  error,
  busy,
  onPin,
  onCancel,
}: {
  open: boolean;
  label: string;
  error: string | null;
  busy: boolean;
  onPin: (pin: string) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="w-auto sm:max-w-none!" data-testid="manager-pin">
        <DialogHeader className="items-center text-center">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <ShieldCheck className="size-5" /> Manager approval
          </DialogTitle>
          <DialogDescription>{label}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-center pb-2">
          <PinPad onComplete={onPin} error={error} busy={busy} active={open} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
