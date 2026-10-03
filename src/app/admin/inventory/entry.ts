import type { StockLine } from "@/lib/inventory";
import { DEFAULT_ENTRY_UNIT, unitsFor } from "@/lib/units";

export type EntryIngredient = {
  id: number;
  name: string;
  storageArea: string;
  units: string[];
  defaultUnit: string;
};

export function toEntry(line: StockLine): EntryIngredient {
  return {
    id: line.id,
    name: line.name,
    storageArea: line.storageArea,
    units: unitsFor(line.baseUnit, line.packs).map((u) => u.name),
    defaultUnit: DEFAULT_ENTRY_UNIT[line.baseUnit],
  };
}

export function byArea<T extends { storageArea: string }>(rows: readonly T[]): { area: string; rows: T[] }[] {
  const groups: { area: string; rows: T[] }[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last?.area === row.storageArea) last.rows.push(row);
    else groups.push({ area: row.storageArea, rows: [row] });
  }
  return groups;
}
