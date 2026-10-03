"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { keepUnlocked, lockTerminal, switchEmployee } from "@/app/pos/actions";
import type { Actor } from "@/lib/orders";
import { failureText } from "./context";

const RENEW_MS = 20_000;

export type PosSession = {
  staff: Actor | null;
  /** Who unlocked last, for the lock screen's greeting. */
  lastName: string | null;
  lock: () => void;
  /** Resolves to the error to show on the PIN pad, or null once unlocked. */
  unlock: (pin: string) => Promise<string | null>;
};

/**
 * Who is at the terminal. Locks after `lockSeconds` without a tap or a key,
 * and renews the server-side unlock while someone is working.
 */
export function usePosSession(initialStaff: Actor | null, lockSeconds: number, onUnlock: () => void): PosSession {
  const router = useRouter();
  const [staff, setStaff] = useState(initialStaff);
  const [lastName, setLastName] = useState(initialStaff?.name ?? null);
  const lastActivity = useRef(0);
  const lastRenew = useRef(0);

  const lock = useCallback(() => {
    setStaff(null);
    lockTerminal().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!staff) return;
    lastActivity.current = Date.now();
    const onActivity = () => {
      lastActivity.current = Date.now();
      if (Date.now() - lastRenew.current < RENEW_MS) return;
      lastRenew.current = Date.now();
      keepUnlocked()
        .then((r) => !r.ok && lock())
        .catch(() => undefined);
    };
    const tick = setInterval(() => {
      if (Date.now() - lastActivity.current > lockSeconds * 1000) lock();
    }, 1000);
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    return () => {
      clearInterval(tick);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [staff, lockSeconds, lock]);

  const unlock = async (pin: string): Promise<string | null> => {
    try {
      const r = await switchEmployee(pin);
      if (!r.ok) {
        if (r.reason === "signed_out") router.replace("/admin/login");
        return failureText(r);
      }
      // Before setStaff, so whatever onUnlock sets lands in the same render.
      onUnlock();
      setStaff(r.actor);
      setLastName(r.actor.name);
      lastRenew.current = Date.now();
      return null;
    } catch {
      return failureText({ ok: false, reason: "offline" });
    }
  };

  return { staff, lastName, lock, unlock };
}
