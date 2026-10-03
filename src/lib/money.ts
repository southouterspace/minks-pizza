/** All money is integer cents. */

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

/**
 * A basis-point share of an amount (875 = 8.75%), rounded half-up in
 * integers: tax, percent discounts and percent comps all round here.
 */
export function bpsOf(amountCents: number, bps: number): number {
  return Math.floor((amountCents * bps + 5_000) / 10_000);
}

/** Dollars string for the defaultValue of a money input: 1250 → "12.50". */
export function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** "12.50" → 1250; blank is 0; anything negative or unreadable is null. */
export function parseDollars(raw: string): number | null {
  if (raw.trim() === "") return 0;
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) || n < 0 ? null : Math.round(n * 100);
}

/** "12.5" → 1250, "$1,200" → 120000; null when it isn't money. */
export function parseCents(s: string): number | null {
  const t = s.replace(/[$,\s]/g, "");
  if (!/^\d*(\.\d{0,2})?$/.test(t) || t === "" || t === ".") return null;
  return Math.round(Number(t) * 100);
}
