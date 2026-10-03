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

/**
 * "Aug 13, 2:45 PM". Pass the store's zone for order times: the server
 * renders in UTC, which is nobody's wall clock.
 */
export function formatDateTime(d: Date, timeZone?: string): string {
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}

/** Compact elapsed time: "45s", "12m", "1h 05m". */
export function formatAge(since: Date, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
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

/** Dollars string for defaultValue of a money input. */
export function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}
