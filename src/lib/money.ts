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

/** "12.5" → 1250, "$1,200" → 120000; null when it isn't money. */
export function parseCents(s: string): number | null {
  const t = s.replace(/[$,\s]/g, "");
  if (!/^\d*(\.\d{0,2})?$/.test(t) || t === "" || t === ".") return null;
  return Math.round(Number(t) * 100);
}
