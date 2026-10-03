import { trimAmount, UNITS, type BaseUnit, type UnitDef } from "@/lib/units";

export function unitFor(
  name: string,
  baseUnit: BaseUnit,
  packs: readonly UnitDef[] = [],
): UnitDef | undefined {
  return packs.find((u) => u.name === name) ?? UNITS[baseUnit].find((u) => u.name === name);
}

export function costToMillicents(centsPerUnit: number, unit: UnitDef): number {
  return Math.round((centsPerUnit * 1_000_000) / unit.baseQtyMilli);
}

export function centsPerUnit(unitCostMillicents: number, unit: UnitDef): number {
  return (unitCostMillicents * unit.baseQtyMilli) / 1_000_000;
}

export const COST_DISPLAY_UNIT: Record<BaseUnit, string> = { g: "lb", ml: "gal", each: "each" };

export const ENTRY_UNIT: Record<BaseUnit, string> = { g: "oz", ml: "fl oz", each: "each" };

export function formatUnitCost(unitCostMillicents: number, baseUnit: BaseUnit): string {
  const name = COST_DISPLAY_UNIT[baseUnit];
  const unit = UNITS[baseUnit].find((u) => u.name === name)!;
  const cents = centsPerUnit(unitCostMillicents, unit);
  const dollars = (cents / 100).toFixed(cents < 10 && cents > 0 ? 4 : 2);
  return `$${dollars}/${name}`;
}

function readsCleanly(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) < 0.05;
}

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

export function amountIn(milli: number, unit: UnitDef): string {
  return trimAmount(milli / unit.baseQtyMilli);
}
