/**
 * Inventory ledger vocabulary. The schema builds its enums from these tuples.
 * Shared by server and client — no I/O.
 */

export const INVENTORY_MOVE_KINDS = ["sale", "receive", "waste", "count"] as const;
export type InventoryMoveKind = (typeof INVENTORY_MOVE_KINDS)[number];

export const WASTE_REASONS = ["dropped", "burnt", "expired", "remake", "other"] as const;
export type WasteReason = (typeof WASTE_REASONS)[number];

export const WASTE_REASON_LABEL: Record<WasteReason, string> = {
  dropped: "Dropped",
  burnt: "Burnt",
  expired: "Expired",
  remake: "Remake",
  other: "Other",
};

export const COUNT_KINDS = ["full", "spot"] as const;
export type CountKind = (typeof COUNT_KINDS)[number];

/**
 * Food cost of a quantity: milli base units × millicents per base unit, which
 * is 10⁶ times too large for cents. Rounded half up.
 */
export function milliToCents(qtyMilli: number, unitCostMillicents: number): number {
  return Math.round((qtyMilli * unitCostMillicents) / 1_000_000);
}
