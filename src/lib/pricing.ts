/**
 * Line pricing, shared by the POS client (instant totals) and the server
 * (authoritative). Pure: no I/O, no framework.
 */
import type { KitchenStation } from "@/lib/kds";

export const GROUP_ROLES = ["size", "crust", "sauce", "cheese", "topping", "option"] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

/** Only these roles take a half placement and an amount. */
export const PLACEABLE_ROLES = ["sauce", "cheese", "topping"] as const;
export type PlaceableRole = (typeof PLACEABLE_ROLES)[number];
export type OptionRole = Exclude<GroupRole, PlaceableRole>;

export const PLACEMENTS = ["whole", "left", "right"] as const;
export type Placement = (typeof PLACEMENTS)[number];

/** `none` is an explicit removal ("NO onions"), priced at zero. */
export const AMOUNTS = ["regular", "extra", "light", "none"] as const;
export type Amount = (typeof AMOUNTS)[number];

export const HALF_TOPPING_RULES = ["average", "highest"] as const;
export type HalfToppingRule = (typeof HALF_TOPPING_RULES)[number];

export function isPlaceable(role: GroupRole): role is PlaceableRole {
  return (PLACEABLE_ROLES as readonly GroupRole[]).includes(role);
}

/**
 * A priced, snapshotted choice on an order line, stored in
 * `order_items.modifiers`. Placement exists only on placeable roles, so a
 * "left half of Size" cannot be built. `modifierId` is null on lines written
 * before modifiers carried ids.
 */
export type LineModifier =
  | {
      kind: "option";
      modifierId: number | null;
      role: OptionRole;
      groupName: string;
      modifierName: string;
      priceDeltaCents: number;
    }
  | {
      kind: "placed";
      modifierId: number | null;
      role: PlaceableRole;
      groupName: string;
      modifierName: string;
      priceDeltaCents: number;
      placement: Placement;
      amount: Amount;
    };

export type Selection = { modifierId: number; placement: Placement; amount: Amount };

export type MenuModifier = {
  id: number;
  name: string;
  priceDeltaCents: number;
  isDefault: boolean;
  isAvailable: boolean;
};

export type MenuGroup = {
  id: number;
  name: string;
  role: GroupRole;
  minSelect: number;
  maxSelect: number | null;
  modifiers: MenuModifier[];
};

export type MenuItem = {
  id: number;
  name: string;
  description: string | null;
  basePriceCents: number;
  isAvailable: boolean;
  station: KitchenStation;
  groups: MenuGroup[];
};

export type PricingPolicy = { halfToppingRule: HalfToppingRule; extraToppingBps: number };

export class PricingError extends Error {}

const roundHalfUp = (n: number) => Math.round(n);

function amountWeight(deltaCents: number, amount: Amount, policy: PricingPolicy): number {
  switch (amount) {
    case "none":
      return 0;
    case "light":
    case "regular":
      return deltaCents;
    case "extra":
      return roundHalfUp((deltaCents * policy.extraToppingBps) / 10_000);
  }
}

/**
 * unit = base + Σ option deltas + toppings, where over placeable groups
 * L = Σw(whole ∪ left), R = Σw(whole ∪ right) and toppings is
 * roundHalfUp((L + R) / 2) under `average` or max(L, R) under `highest`.
 * "Half price per half topping" is algebraically `average`, so it has no
 * value of its own.
 */
export function priceLine(
  item: MenuItem,
  selections: Selection[],
  policy: PricingPolicy,
): { unitPriceCents: number; modifiers: LineModifier[] } {
  if (!item.isAvailable) {
    throw new PricingError(`"${item.name}" is no longer available.`);
  }
  const owner = new Map<number, { group: MenuGroup; mod: MenuModifier }>();
  for (const group of item.groups) {
    for (const mod of group.modifiers) owner.set(mod.id, { group, mod });
  }

  const seen = new Set<number>();
  const counts = new Map<number, number>();
  const modifiers: LineModifier[] = [];
  let optionCents = 0;
  let left = 0;
  let right = 0;

  for (const s of selections) {
    const found = owner.get(s.modifierId);
    if (!found || !found.mod.isAvailable) {
      throw new PricingError(`An option on "${item.name}" is no longer available.`);
    }
    if (seen.has(s.modifierId)) {
      throw new PricingError(`${found.mod.name} is chosen twice on "${item.name}".`);
    }
    seen.add(s.modifierId);
    const { group, mod } = found;
    if (s.amount !== "none") counts.set(group.id, (counts.get(group.id) ?? 0) + 1);

    const base = { modifierId: mod.id, groupName: group.name, modifierName: mod.name, priceDeltaCents: mod.priceDeltaCents };
    if (isPlaceable(group.role)) {
      const w = amountWeight(mod.priceDeltaCents, s.amount, policy);
      if (s.placement !== "right") left += w;
      if (s.placement !== "left") right += w;
      modifiers.push({ kind: "placed", role: group.role, placement: s.placement, amount: s.amount, ...base });
    } else {
      if (s.placement !== "whole" || s.amount !== "regular") {
        throw new PricingError(`${group.name} on "${item.name}" cannot be split or changed in amount.`);
      }
      optionCents += mod.priceDeltaCents;
      modifiers.push({ kind: "option", role: group.role, ...base });
    }
  }

  for (const group of item.groups) {
    const count = counts.get(group.id) ?? 0;
    if (count < group.minSelect) {
      throw new PricingError(`"${item.name}" requires a ${group.name} selection.`);
    }
    if (group.maxSelect !== null && count > group.maxSelect) {
      throw new PricingError(`Too many ${group.name} selections on "${item.name}".`);
    }
  }

  const toppings =
    policy.halfToppingRule === "average" ? roundHalfUp((left + right) / 2) : Math.max(left, right);
  return { unitPriceCents: item.basePriceCents + optionCents + toppings, modifiers };
}

/**
 * Splits `total` cents in proportion to `weights` by largest remainder; ties
 * go to the earlier share. The shares always sum to `total`.
 * allocate(1000, [1, 1, 1]) → [334, 333, 333].
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (weights.length === 0 || sum <= 0) {
    throw new RangeError("allocate needs at least one positive weight");
  }
  const exact = weights.map((w) => (total * w) / sum);
  const shares = exact.map(Math.floor);
  let left = total - shares.reduce((a, s) => a + s, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i] += 1;
    left -= 1;
  }
  return shares;
}

export function splitEvenly(total: number, n: number): number[] {
  return allocate(total, Array.from({ length: n }, () => 1));
}

/**
 * Each guest's share of `dueCents` when the check is split by who had what.
 * A line with no guests listed is shared by everyone. Each line's cents go to
 * its guests through `allocate`, then the balance (tax, fees and check
 * discounts included) follows those item cents, so the shares are
 * deterministic and always sum to the due.
 */
export function shareByItem(dueCents: number, guests: number, lines: readonly { cents: number; guests: readonly number[] }[]): number[] {
  const everyone = Array.from({ length: guests }, (_, g) => g);
  const weights = everyone.map(() => 0);
  for (const l of lines) {
    const who = l.guests.length > 0 ? l.guests : everyone;
    allocate(l.cents, who.map(() => 1)).forEach((c, i) => (weights[who[i]] += c));
  }
  return weights.some((w) => w > 0) ? allocate(dueCents, weights) : splitEvenly(dueCents, guests);
}

export type ReorderLine = {
  itemId: number;
  name: string;
  quantity: number;
  notes: string | null;
  selections: Selection[];
  unitPriceCents: number;
  modifiers: LineModifier[];
};

/**
 * Re-prices past lines at today's menu. A line whose item, or any of whose
 * options, is 86'd or gone comes back in `unavailable` instead.
 */
export function reorderLines(
  past: { itemId: number | null; name: string; quantity: number; notes: string | null; modifiers: LineModifier[] }[],
  menu: MenuItem[],
  policy: PricingPolicy,
): { lines: ReorderLine[]; unavailable: { name: string; reason: string }[] } {
  const byId = new Map(menu.map((i) => [i.id, i]));
  const lines: ReorderLine[] = [];
  const unavailable: { name: string; reason: string }[] = [];
  for (const line of past) {
    const item = line.itemId === null ? undefined : byId.get(line.itemId);
    if (!item) {
      unavailable.push({ name: line.name, reason: "No longer on the menu" });
      continue;
    }
    const selections: Selection[] = [];
    let missing: string | null = null;
    for (const m of line.modifiers) {
      if (m.modifierId === null) {
        missing = m.modifierName;
        break;
      }
      selections.push(
        m.kind === "placed"
          ? { modifierId: m.modifierId, placement: m.placement, amount: m.amount }
          : { modifierId: m.modifierId, placement: "whole", amount: "regular" },
      );
    }
    if (missing !== null) {
      unavailable.push({ name: line.name, reason: `${missing} can't be matched to today's menu` });
      continue;
    }
    try {
      const { unitPriceCents, modifiers } = priceLine(item, selections, policy);
      lines.push({ itemId: item.id, name: item.name, quantity: line.quantity, notes: line.notes, selections, unitPriceCents, modifiers });
    } catch (err) {
      if (!(err instanceof PricingError)) throw err;
      unavailable.push({ name: line.name, reason: err.message });
    }
  }
  return { lines, unavailable };
}

/**
 * Minutes until a new pie is out: one make, then one bake per oven load
 * ahead of it plus its own, floored at the store's static prep time.
 */
export function quoteMinutes(q: {
  piesAhead: number;
  ovenCapacityPies: number;
  ovenMinutes: number;
  makeMinutes: number;
  baseMinutes: number;
}): number {
  const loads = Math.floor(q.piesAhead / Math.max(1, q.ovenCapacityPies)) + 1;
  return Math.max(q.baseMinutes, q.makeMinutes + loads * q.ovenMinutes);
}
