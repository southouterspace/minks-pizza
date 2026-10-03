/** All money is integer cents. */

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

/** Tax from basis points (875 = 8.75%), rounded half-up per industry norm. */
export function taxFromBps(subtotalCents: number, taxRateBps: number): number {
  return Math.round((subtotalCents * taxRateBps) / 10_000);
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
