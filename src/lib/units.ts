/**
 * Ingredient quantities. Storage is integer milli base units (1 g = 1000,
 * 1 ml = 1000, 1 each = 1000); kitchens enter and read oz, lb, fl oz, quarts.
 * Shared by server and client — no I/O.
 */

export const BASE_UNITS = ["g", "ml", "each"] as const;
export type BaseUnit = (typeof BASE_UNITS)[number];

export const BASE_UNIT_LABEL: Record<BaseUnit, string> = {
  g: "Weight",
  ml: "Volume",
  each: "Count",
};

/** A unit the kitchen can enter, as a multiple of the base unit. */
export type UnitDef = { name: string; baseQtyMilli: number };

export const UNITS: Record<BaseUnit, readonly UnitDef[]> = {
  g: [
    { name: "g", baseQtyMilli: 1_000 },
    { name: "kg", baseQtyMilli: 1_000_000 },
    { name: "oz", baseQtyMilli: 28_350 },
    { name: "lb", baseQtyMilli: 453_592 },
  ],
  ml: [
    { name: "ml", baseQtyMilli: 1_000 },
    { name: "l", baseQtyMilli: 1_000_000 },
    { name: "fl oz", baseQtyMilli: 29_574 },
    { name: "qt", baseQtyMilli: 946_353 },
    { name: "gal", baseQtyMilli: 3_785_412 },
  ],
  each: [{ name: "each", baseQtyMilli: 1_000 }],
};

const ALL_UNITS: readonly UnitDef[] = BASE_UNITS.flatMap((b) => UNITS[b]);

export function findUnit(name: string, packs: readonly UnitDef[] = []): UnitDef | undefined {
  return packs.find((u) => u.name === name) ?? ALL_UNITS.find((u) => u.name === name);
}

/**
 * `qty` of `unit` (a standard unit or one of the ingredient's packs, which
 * win on a name clash) as integer milli base units. Throws on an unknown
 * unit: forms validate the name before calling.
 */
export function toMilli(qty: number, unit: string, packs: readonly UnitDef[] = []): number {
  const def = findUnit(unit, packs);
  if (!def) throw new RangeError(`Unknown unit "${unit}"`);
  return Math.round(qty * def.baseQtyMilli);
}

function trim(n: number, decimals: number): string {
  return n.toFixed(decimals).replace(/\.?0+$/, "");
}

/** On-hand quantities in the units a US kitchen reads: oz under a pound, lb above. */
export function formatQty(milli: number, baseUnit: BaseUnit): string {
  const sign = milli < 0 ? "-" : "";
  const abs = Math.abs(milli);
  switch (baseUnit) {
    case "g":
      return abs >= 453_592
        ? `${sign}${trim(abs / 453_592, 2)} lb`
        : `${sign}${trim(abs / 28_350, 1)} oz`;
    case "ml":
      if (abs >= 3_785_412) return `${sign}${trim(abs / 3_785_412, 2)} gal`;
      if (abs >= 946_353) return `${sign}${trim(abs / 946_353, 2)} qt`;
      return `${sign}${trim(abs / 29_574, 1)} fl oz`;
    case "each":
      return `${sign}${trim(abs / 1_000, 1)}`;
  }
}
