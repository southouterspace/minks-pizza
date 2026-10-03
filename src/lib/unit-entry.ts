/**
 * Turning what a kitchen types ("$38.50 per case", "8 oz") into stored milli
 * quantities and millicent costs, and picking a readable unit to show stored
 * values back in. Shared by server and client — no I/O.
 */
import { UNITS, type BaseUnit, type UnitDef } from "@/lib/units";

/** A unit by name among the ones `unitsFor` in units.ts offers; undefined for another family's unit. */
export function unitFor(
  name: string,
  baseUnit: BaseUnit,
  packs: readonly UnitDef[] = [],
): UnitDef | undefined {
  return packs.find((u) => u.name === name) ?? UNITS[baseUnit].find((u) => u.name === name);
}

/** "$38.50 per case of 20 lb" → millicents per base unit, rounded. */
export function costToMillicents(centsPerUnit: number, unit: UnitDef): number {
  return Math.round((centsPerUnit * 1_000_000) / unit.baseQtyMilli);
}

/** Price of one `unit`, in (fractional) cents. */
export function centsPerUnit(unitCostMillicents: number, unit: UnitDef): number {
  return (unitCostMillicents * unit.baseQtyMilli) / 1_000_000;
}

/** How unit costs read in lists: pounds, gallons, each. */
export const COST_DISPLAY_UNIT: Record<BaseUnit, string> = { g: "lb", ml: "gal", each: "each" };

/** The unit a kitchen enters small amounts of this ingredient in. */
export const ENTRY_UNIT: Record<BaseUnit, string> = { g: "oz", ml: "fl oz", each: "each" };

/** "$4.00/lb"; fractions of a cent show when the cost is under a dime. */
export function formatUnitCost(unitCostMillicents: number, baseUnit: BaseUnit): string {
  const name = COST_DISPLAY_UNIT[baseUnit];
  const unit = UNITS[baseUnit].find((u) => u.name === name)!;
  const cents = centsPerUnit(unitCostMillicents, unit);
  const dollars = (cents / 100).toFixed(cents < 10 && cents > 0 ? 4 : 2);
  return `$${dollars}/${name}`;
}

/** At most `decimals` places, trailing zeros dropped: 8, 0.25, 1.333. */
export function trimAmount(n: number, decimals = 3): string {
  return n.toFixed(decimals).replace(/\.?0+$/, "").replace(/^-0$/, "0");
}

/** Within rounding of the milli storage, `v` has at most two decimals. */
function readsCleanly(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) < 0.05;
}

/**
 * The unit to show stored quantities in: the largest standard unit where every
 * value is at least 1 and reads with two decimals or fewer, else the kitchen's
 * entry unit. 20 lb stays lb, 8 oz stays oz, 0.25 oz stays oz.
 */
export function readableUnit(milliValues: readonly number[], baseUnit: BaseUnit): UnitDef {
  const entry = UNITS[baseUnit].find((u) => u.name === ENTRY_UNIT[baseUnit])!;
  const values = milliValues.filter((m) => m !== 0).map(Math.abs);
  if (values.length === 0) return entry;
  const largestFirst = [...UNITS[baseUnit]].sort((a, b) => b.baseQtyMilli - a.baseQtyMilli);
  return (
    largestFirst.find((u) =>
      values.every((m) => {
        const v = m / u.baseQtyMilli;
        return readsCleanly(v) && (u === entry || v >= 1);
      }),
    ) ?? entry
  );
}

/** A stored quantity as the number to prefill an input with. */
export function amountIn(milli: number, unit: UnitDef): string {
  return trimAmount(milli / unit.baseQtyMilli);
}
