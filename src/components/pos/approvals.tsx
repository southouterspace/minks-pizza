"use client";

import { useCallback, useState, type ReactNode } from "react";
import type { Approval } from "@/lib/orders";
import { failureText, type ActionResult, type Pos } from "./context";
import { ManagerPinDialog } from "./pin-pad";

type PendingApproval = {
  label: string;
  call: (approval?: Approval) => Promise<ActionResult>;
  resolve: (r: ActionResult | null) => void;
  error: string | null;
  busy: boolean;
};

/**
 * `act` and the manager PIN pad it opens. Every call runs through `write`
 * (the board's mutate, so a poll can't undo it on screen); a failure other
 * than `needs_manager` goes to `fail`.
 */
export function useApprovals({
  write,
  fail,
}: {
  write: <R>(run: () => Promise<R>) => Promise<R>;
  fail: (r: { reason: string; message?: string }) => void;
}): { act: Pos["act"]; approvalDialog: ReactNode } {
  const [approval, setApproval] = useState<PendingApproval | null>(null);

  const act = useCallback(
    async <T extends ActionResult>(label: string, call: (approval?: Approval) => Promise<T>) => {
      let r: T;
      try {
        r = await write(() => call());
      } catch {
        fail({ reason: "offline" });
        return null;
      }
      if (r.ok) return r as Extract<T, { ok: true }>;
      if (r.reason !== "needs_manager") {
        fail(r);
        return null;
      }
      const approved = await new Promise<ActionResult | null>((resolve) =>
        setApproval({ label, call: call as PendingApproval["call"], resolve, error: null, busy: false }),
      );
      return approved as Extract<T, { ok: true }> | null;
    },
    [fail, write],
  );

  const onManagerPin = async (pin: string) => {
    const a = approval;
    if (!a) return;
    setApproval({ ...a, busy: true, error: null });
    let r: ActionResult;
    try {
      r = await write(() => a.call({ managerPin: pin }));
    } catch {
      setApproval({ ...a, busy: false, error: failureText({ reason: "offline" }) });
      return;
    }
    if (r.ok) {
      setApproval(null);
      a.resolve(r);
      return;
    }
    const retryable: Record<string, string> = {
      bad_pin: "Wrong PIN. Try again.",
      needs_manager: "That PIN isn't a manager's.",
      locked_out: failureText({ reason: "locked_out" }),
    };
    if (r.reason in retryable) {
      setApproval({ ...a, busy: false, error: retryable[r.reason] });
      return;
    }
    setApproval(null);
    a.resolve(null);
    fail(r);
  };

  const approvalDialog = (
    <ManagerPinDialog
      open={approval !== null}
      label={approval?.label ?? ""}
      error={approval?.error ?? null}
      busy={approval?.busy ?? false}
      onPin={(pin) => void onManagerPin(pin)}
      onCancel={() => {
        approval?.resolve(null);
        setApproval(null);
      }}
    />
  );

  return { act, approvalDialog };
}
