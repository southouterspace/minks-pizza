"use client";

import { useCallback, useState, type ReactNode } from "react";
import type { ActionFailure, Approval } from "@/lib/orders";
import { failureText, type Pos } from "./context";
import { ManagerPinDialog } from "./pin-pad";

type PendingApproval = {
  label: string;
  error: string | null;
  busy: boolean;
  tryPin: (pin: string) => Promise<void>;
  cancel: () => void;
};

/** Failures the manager PIN pad answers by asking again. */
const TRY_AGAIN: Partial<Record<ActionFailure["reason"], string>> = {
  bad_pin: "Wrong PIN. Try again.",
  needs_manager: "That PIN isn't a manager's.",
  locked_out: failureText({ ok: false, reason: "locked_out" }),
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
  fail: (r: ActionFailure) => void;
}): { act: Pos["act"]; approvalDialog: ReactNode } {
  const [approval, setApproval] = useState<PendingApproval | null>(null);

  const act = useCallback(
    async <S extends { ok: true }>(label: string, call: (approval?: Approval) => Promise<S | ActionFailure>): Promise<S | null> => {
      const attempt = async (approval?: Approval): Promise<S | ActionFailure> => {
        try {
          return await write(() => call(approval));
        } catch {
          return { ok: false, reason: "offline" };
        }
      };
      const r = await attempt();
      if (r.ok) return r;
      if (r.reason !== "needs_manager") {
        fail(r);
        return null;
      }
      return new Promise<S | null>((resolve) => {
        const settle = (result: S | null) => {
          setApproval(null);
          resolve(result);
        };
        setApproval({
          label,
          error: null,
          busy: false,
          cancel: () => settle(null),
          tryPin: async (pin) => {
            setApproval((a) => a && { ...a, busy: true, error: null });
            const again = await attempt({ managerPin: pin });
            if (again.ok) return settle(again);
            const retry = again.reason === "offline" ? failureText(again) : TRY_AGAIN[again.reason];
            if (retry) return setApproval((a) => a && { ...a, busy: false, error: retry });
            settle(null);
            fail(again);
          },
        });
      });
    },
    [fail, write],
  );

  const approvalDialog = (
    <ManagerPinDialog
      open={approval !== null}
      label={approval?.label ?? ""}
      error={approval?.error ?? null}
      busy={approval?.busy ?? false}
      onPin={(pin) => void approval?.tryPin(pin)}
      onCancel={() => approval?.cancel()}
    />
  );

  return { act, approvalDialog };
}
