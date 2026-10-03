/** Tiny pure formatters shared across the admin dashboard. */

/** "Required, pick 1" style rule summary for a modifier group. */
export function ruleSummary(
  minSelect: number,
  maxSelect: number | null,
): string {
  if (minSelect > 0) {
    if (maxSelect === null) return `Required, pick at least ${minSelect}`;
    if (maxSelect === minSelect) return `Required, pick ${minSelect}`;
    return `Required, pick ${minSelect}–${maxSelect}`;
  }
  if (maxSelect === 1) return "Optional, pick 1";
  if (maxSelect === null) return "Optional";
  return `Optional, up to ${maxSelect}`;
}

/** "Aug 13, 2:45 PM" */
export function formatDateTime(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Signed price delta: "+$1.50", "−$0.50", or "No charge". */
export function formatDelta(cents: number): string {
  if (cents === 0) return "No charge";
  const abs = (Math.abs(cents) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
  return cents > 0 ? `+${abs}` : `−${abs}`;
}

