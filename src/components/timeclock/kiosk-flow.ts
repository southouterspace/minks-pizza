/**
 * The kiosk's screen flow as a pure reducer. Each screen carries its own
 * fields; the PIN lives on the employee screens only and is dropped on the
 * way back to the pad, so the tablet never keeps anyone signed in.
 */
import { PIN_LENGTH, type KioskResponse, type KioskView, type ShiftSummary } from "@/lib/timeclock";

export type Screen =
  | { kind: "pad"; digits: string; error: string | null; shake: number }
  | { kind: "employee"; pin: string; view: KioskView; error: string | null }
  | { kind: "clock_out"; pin: string; view: KioskView }
  | { kind: "time_off"; pin: string; view: KioskView }
  | { kind: "done"; view: KioskView; message: string; tone: KioskResponse["tone"]; summary: ShiftSummary | null };

export type KioskResult = { ok: true; data: KioskResponse } | { ok: false; status: number; code?: string; error: string };

export type KioskEvent =
  | { type: "digit"; digit: string }
  | { type: "backspace" }
  | { type: "clear" }
  | { type: "goto"; to: "employee" | "clock_out" | "time_off" }
  | { type: "pin_result"; pin: string; result: KioskResult }
  | { type: "action_result"; pin: string; result: KioskResult }
  /** Idle timeout, Done, or a failed request (with its error for the pad). */
  | { type: "reset"; error?: string };

export const PAD: Extract<Screen, { kind: "pad" }> = { kind: "pad", digits: "", error: null, shake: 0 };

const CONFIRM_MS = 4_000;
const IDLE_MS = 20_000;

/** Walk-away safety: how long each screen waits before returning to the pad. */
export const SCREEN_TIMEOUT_MS: Record<Screen["kind"], number | null> = {
  pad: null,
  employee: IDLE_MS,
  clock_out: IDLE_MS,
  time_off: IDLE_MS,
  done: CONFIRM_MS,
};

export function kioskReducer(screen: Screen, event: KioskEvent): Screen {
  switch (event.type) {
    case "digit":
      if (screen.kind !== "pad") return screen;
      return {
        ...screen,
        error: null,
        digits: screen.digits.length >= PIN_LENGTH.max ? screen.digits : screen.digits + event.digit,
      };
    case "backspace":
      return screen.kind === "pad" ? { ...screen, digits: screen.digits.slice(0, -1) } : screen;
    case "clear":
      return screen.kind === "pad" ? { ...screen, digits: "" } : screen;
    case "goto":
      if (screen.kind === "pad" || screen.kind === "done") return screen;
      if (event.to === "employee") return { kind: "employee", pin: screen.pin, view: screen.view, error: null };
      return { kind: event.to, pin: screen.pin, view: screen.view };
    case "pin_result":
      if (event.result.ok) return { kind: "employee", pin: event.pin, view: event.result.data.view, error: null };
      return { kind: "pad", digits: "", error: event.result.error, shake: screen.kind === "pad" ? screen.shake + 1 : 1 };
    case "action_result": {
      if (!event.result.ok) return { ...PAD, error: event.result.error };
      const { view, message, tone, summary } = event.result.data;
      if (tone === "error") return { kind: "employee", pin: event.pin, view, error: message };
      return { kind: "done", view, message: message ?? "Saved.", tone, summary };
    }
    case "reset":
      return { ...PAD, error: event.error ?? null };
  }
}
