/** Reading server-action FormData: trimmed strings, ids, cents. */
import { parseDollars } from "@/lib/money";

export function textField(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v.trim() : "";
}

export function textOrNull(fd: FormData, name: string): string | null {
  const v = textField(fd, name);
  return v === "" ? null : v;
}

export function checkbox(fd: FormData, name: string): boolean {
  return fd.get(name) === "on";
}

/** Required positive integer id (from a hidden input). Throws when tampered. */
export function idField(fd: FormData, name: string): number {
  const n = Number.parseInt(textField(fd, name), 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}`);
  return n;
}

/** Non-negative integer with a fallback for blank/invalid input. */
export function intField(fd: FormData, name: string, fallback: number): number {
  const n = Number.parseInt(textField(fd, name), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(0, n);
}

/** Dollars string ("12.50") → integer cents. Blank = 0. Throws on bad input. */
export function dollarsToCents(fd: FormData, name: string): number {
  const cents = parseDollars(textField(fd, name));
  if (cents === null) throw new Error(`Invalid ${name}`);
  return cents;
}

/** Dollars string → integer cents, or null when it isn't a non-negative amount. Blank = 0. */
export function centsField(fd: FormData, name: string): number | null {
  return parseDollars(textField(fd, name));
}

/** A blank hidden id is null (a new row); otherwise it must be a valid id. */
export function optionalIdField(fd: FormData, name: string): number | null {
  return textField(fd, name) === "" ? null : idField(fd, name);
}

/**
 * Every field as trimmed text, keyed by name, for a zod schema that names
 * the form's own fields. Names in `arrays` keep all their values.
 */
export function formFields(fd: FormData, arrays: readonly string[] = []): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const name of new Set(fd.keys())) {
    out[name] = arrays.includes(name)
      ? fd.getAll(name).filter((v): v is string => typeof v === "string")
      : textField(fd, name);
  }
  return out;
}
