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
