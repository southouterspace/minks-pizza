"use client";

import { createContext, useContext } from "react";
import type { ActionFailure, StaffActor, Approval, Board, PosMenu } from "@/lib/orders";

export type StoreInfo = {
  name: string;
  phone: string | null;
  address: string | null;
  /** IANA zone every time on the terminal, its tickets and its receipts is shown in. */
  timeZone: string;
};

export type Pos = {
  menu: PosMenu;
  board: Board;
  staff: StaffActor;
  store: StoreInfo;
  online: boolean;
  /** Wall clock, ticked by the board poll; render code reads this, not Date.now(). */
  now: number;
  /**
   * Runs a server action and handles the outcomes every caller shares: a
   * manager PIN pad on `needs_manager` (then the same call again with the
   * approval), back to the lock screen on `locked`, and a toast for any other
   * failure or a dropped connection. Resolves to the success or null.
   */
  act: <S extends { ok: true }>(label: string, call: (approval?: Approval) => Promise<S | ActionFailure>) => Promise<S | null>;
  refreshBoard: () => Promise<void>;
  openOrder: (orderId: string) => void;
};

export const PosContext = createContext<Pos | null>(null);

export function usePos(): Pos {
  const pos = useContext(PosContext);
  if (!pos) throw new Error("usePos outside the terminal");
  return pos;
}

const FAILURE_TEXT: Record<Exclude<ActionFailure["reason"], "rejected">, string> = {
  needs_manager: "A manager has to approve this.",
  bad_pin: "That PIN didn't match anyone.",
  locked_out: "Too many wrong PINs. This terminal is locked for 5 minutes.",
  no_open_shift: "No shift is open. Open a shift first.",
  not_found: "That order no longer exists.",
  locked: "The terminal locked. Enter your PIN.",
  signed_out: "This device is signed out. Sign in at /admin/login.",
  offline: "Can't reach the server. This needs an internet connection.",
};

export function failureText(r: ActionFailure): string {
  return r.reason === "rejected" ? r.message : FAILURE_TEXT[r.reason];
}
