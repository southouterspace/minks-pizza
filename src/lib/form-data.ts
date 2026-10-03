/** Reading server-action FormData: trimmed strings, ids, cents. */

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

/** Dollars string ("12.50") → integer cents. Blank = 0. */
export function dollarsToCents(fd: FormData, name: string): number {
  const raw = textField(fd, name);
  if (raw === "") return 0;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n) || n < 0) throw new Error(`Invalid ${name}`);
  return Math.round(n * 100);
}
