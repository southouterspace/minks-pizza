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
