/**
 * Pizza builder rules: what a fresh line starts with and what each tap does.
 * Pure, so the screen is a view over `Selection[]` and the tests need no DOM.
 */
import {
  GROUP_ROLES,
  type Amount,
  type MenuGroup,
  type MenuItem,
  type MenuModifier,
  type Placement,
  type Selection,
} from "@/lib/pricing";

/** Builder entry order: size → crust → sauce → cheese → toppings → the rest. */
export function groupsInEntryOrder(item: MenuItem): MenuGroup[] {
  return item.groups.toSorted((a, b) => GROUP_ROLES.indexOf(a.role) - GROUP_ROLES.indexOf(b.role));
}

/** Items with options open the builder; plain items go straight on the order. */
export const needsBuilder = (item: MenuItem) => item.groups.length > 0;

export function defaultSelections(item: MenuItem): Selection[] {
  return item.groups.flatMap((g) =>
    g.modifiers
      .filter((m) => m.isDefault && m.isAvailable)
      .slice(0, g.maxSelect ?? undefined)
      .map((m): Selection => ({ modifierId: m.id, placement: "whole", amount: "regular" })),
  );
}

/** Radio for single-choice groups, toggle for the rest. Not for placeable groups. */
export function pickOption(sel: Selection[], group: MenuGroup, mod: MenuModifier): Selection[] {
  const inGroup = new Set(group.modifiers.map((m) => m.id));
  const has = sel.some((s) => s.modifierId === mod.id);
  if (group.maxSelect === 1) {
    if (has && group.minSelect === 0) return sel.filter((s) => s.modifierId !== mod.id);
    return [...sel.filter((s) => !inGroup.has(s.modifierId)), { modifierId: mod.id, placement: "whole", amount: "regular" }];
  }
  return has
    ? sel.filter((s) => s.modifierId !== mod.id)
    : [...sel, { modifierId: mod.id, placement: "whole", amount: "regular" }];
}

/**
 * A default topping cycles regular → extra → light → NO → regular; any
 * other cycles off → regular → extra → light → off. Tapping a topping that
 * sits on another half moves it to the active half instead.
 */
export function tapTopping(sel: Selection[], mod: MenuModifier, active: Placement): Selection[] {
  const i = sel.findIndex((s) => s.modifierId === mod.id);
  if (i < 0) return [...sel, { modifierId: mod.id, placement: active, amount: "regular" }];
  const cur = sel[i];
  let next: Selection | null;
  if (cur.placement !== active && cur.amount !== "none") {
    next = { ...cur, placement: active };
  } else {
    const order: (Amount | null)[] = mod.isDefault
      ? ["regular", "extra", "light", "none"]
      : ["regular", "extra", "light", null];
    const amount = order[(order.indexOf(cur.amount) + 1) % order.length];
    next = amount === null ? null : { ...cur, amount, placement: amount === "none" ? "whole" : active };
  }
  return next ? sel.map((s, j) => (j === i ? next : s)) : sel.filter((_, j) => j !== i);
}

const PLACEMENT_CYCLE: Placement[] = ["whole", "left", "right"];

/** Long-press: whole → left → right → whole for one topping. */
export function cyclePlacement(sel: Selection[], mod: MenuModifier): Selection[] {
  const i = sel.findIndex((s) => s.modifierId === mod.id);
  if (i < 0) return [...sel, { modifierId: mod.id, placement: "left", amount: "regular" }];
  const cur = sel[i];
  const placement = PLACEMENT_CYCLE[(PLACEMENT_CYCLE.indexOf(cur.placement) + 1) % 3];
  return sel.map((s, j) => (j === i ? { ...s, placement, amount: s.amount === "none" ? "regular" : s.amount } : s));
}

export function selectionOf(sel: Selection[], modId: number): Selection | undefined {
  return sel.find((s) => s.modifierId === modId);
}
