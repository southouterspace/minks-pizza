/** Shared class strings + tiny formatters for the admin dashboard. */

export const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint focus:border-foreground";

export const labelClass = "mb-1.5 block text-sm font-medium";

export const primaryButtonClass =
  "inline-flex h-9 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40";

export const secondaryButtonClass =
  "inline-flex h-9 items-center justify-center rounded-md border border-border px-4 text-sm font-medium transition-colors hover:border-foreground/40";

export const smallButtonClass =
  "inline-flex h-7 items-center rounded-md border border-border px-2.5 text-xs font-medium text-muted transition-colors hover:border-foreground/40 hover:text-foreground";

export const summaryButtonClass =
  "inline-flex h-7 cursor-pointer list-none items-center rounded-md border border-border px-2.5 text-xs font-medium text-muted transition-colors hover:border-foreground/40 hover:text-foreground [&::-webkit-details-marker]:hidden";

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

/** Dollars string for defaultValue of a money input. */
export function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}
