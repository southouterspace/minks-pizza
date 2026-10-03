import type { z } from "zod";

/** What a loyalty admin form shows after its action: a notice, or errors next to the fields. */
export type LoyaltyFormState = {
  notice?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** On error, what was submitted, so the form comes back as the operator left it. */
  values?: Record<string, string[]>;
};

function submitted(fd: FormData): Record<string, string[]> {
  const values: Record<string, string[]> = {};
  for (const name of new Set(fd.keys())) {
    values[name] = fd.getAll(name).filter((v): v is string => typeof v === "string");
  }
  return values;
}

/**
 * A refusal. Zod issues land on the field their path names (schemas here are
 * keyed by form field names); anything else is the form's own error.
 */
export function rejected(fd: FormData, problem: z.ZodError | string): LoyaltyFormState {
  if (typeof problem === "string") return { error: problem, values: submitted(fd) };
  const fieldErrors: Record<string, string> = {};
  let error: string | undefined;
  for (const issue of problem.issues) {
    const field = issue.path.length > 0 ? String(issue.path[0]) : null;
    if (field && fd.has(field)) fieldErrors[field] ??= issue.message;
    else error ??= issue.message;
  }
  return { error, fieldErrors, values: submitted(fd) };
}
