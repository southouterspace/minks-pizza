"use client";

import { useActionState } from "react";
import type { LoyaltyFormState } from "@/app/admin/loyalty/form-state";
import { FieldError } from "@/components/ui/field";

type Action = (prev: LoyaltyFormState, fd: FormData) => Promise<LoyaltyFormState>;
type State = LoyaltyFormState & { seq: number };

/**
 * A loyalty admin form's action state. `key` changes with every result, so
 * keying the form remounts it: after an error its fields come back as
 * submitted (React's own reset would revert them), after a save they show
 * the saved data.
 */
export function useLoyaltyForm(action: Action) {
  const [state, formAction, pending] = useActionState<State, FormData>(
    async (prev, fd) => ({ ...(await action(prev, fd)), seq: prev.seq + 1 }),
    { seq: 0 },
  );
  const submitted = state.values;
  return {
    state,
    formAction,
    pending,
    key: state.seq,
    /** The submitted text after an error, else `saved`. */
    text: (name: string, saved: string | number | null | undefined) => submitted?.[name]?.[0] ?? String(saved ?? ""),
    /** Whether a checkbox was ticked when submitted after an error, else `saved`. */
    checked: (name: string, saved: boolean, value = "on") => (submitted ? (submitted[name] ?? []).includes(value) : saved),
    error: (name: string) => state.fieldErrors?.[name],
  };
}

export function FieldMessage({ message }: { message: string | undefined }) {
  return message ? <FieldError>{message}</FieldError> : null;
}

/** The form's own outcome, shown where the operator pressed the button. */
export function FormStatus({ state }: { state: LoyaltyFormState }) {
  if (state.error) {
    return (
      <p role="alert" data-testid="form-error" className="text-sm font-medium text-destructive">
        {state.error}
      </p>
    );
  }
  if (state.notice) {
    return (
      <p role="status" data-testid="form-notice" className="text-sm font-medium text-success">
        {state.notice}
      </p>
    );
  }
  return null;
}
