/**
 * Line pricing, shared by the POS client (instant totals) and the server
 * (authoritative). Pure: no I/O, no framework.
 */
import type { KitchenStation } from "@/lib/kds";

export const GROUP_ROLES = ["size", "crust", "sauce", "cheese", "topping", "option"] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

export const GROUP_ROLE_LABEL: Record<GroupRole, string> = {
  size: "Size",
  crust: "Crust",
  sauce: "Sauce",
  cheese: "Cheese",
  topping: "Topping",
  option: "Option",
};

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

export type Prices = {
  priceDeltaCents: number;
  /** What "extra" costs when the menu names a price; null falls back to `extraToppingBps`. */
  extraPriceDeltaCents: number | null;
};

/** A modifier's prices on one size, replacing its own there. */
export type SizePrice = Prices & { sizeModifierId: number };

type SizedPrices = Prices & { sizePrices: readonly SizePrice[] };

export type MenuModifier = Prices & {
  id: number;
  name: string;
  isDefault: boolean;
  isAvailable: boolean;
  sizePrices: SizePrice[];
};

/** What `mod` costs on the size `sizeId`, or its own prices when that size names none. */
export function pricesAt(mod: SizedPrices, sizeId: number | null): Prices {
  const sized = sizeId === null ? undefined : mod.sizePrices.find((p) => p.sizeModifierId === sizeId);
  const { priceDeltaCents, extraPriceDeltaCents } = sized ?? mod;
  return { priceDeltaCents, extraPriceDeltaCents };
}

export const PLACEMENT_LABEL: Record<Placement, string> = {
  whole: "Whole",
  left: "Left half",
  right: "Right half",
};

export const AMOUNT_LABEL: Record<Amount, string> = {
  regular: "Regular",
  extra: "Extra",
  light: "Light",
  none: "None",
};

/** "Pepperoni (left half, extra)", "Mushrooms", "No Onions". */
export function describeChoice(m: LineModifier): string {
  if (m.kind === "option") return m.modifierName;
  if (m.amount === "none") return `No ${m.modifierName}`;
  const parts: string[] = [];
  if (m.placement !== "whole") parts.push(PLACEMENT_LABEL[m.placement].toLowerCase());
  if (m.amount !== "regular") parts.push(m.amount);
  return parts.length ? `${m.modifierName} (${parts.join(", ")})` : m.modifierName;
}

/** The options a plain plate comes with and what they add to its price on `sizeId`; a default topping adds nothing. */
export function plateDefaults(
  groups: readonly { role: GroupRole; modifiers: readonly (SizedPrices & { id: number; isDefault: boolean })[] }[],
  sizeId: number | null,
): { ids: number[]; priceCents: number } {
  const picked = groups.flatMap((g) => g.modifiers.filter((m) => m.isDefault).map((m) => ({ m, placeable: isPlaceable(g.role) })));
  return {
    ids: picked.map(({ m }) => m.id),
    priceCents: picked.reduce((sum, { m, placeable }) => sum + (placeable ? 0 : pricesAt(m, sizeId).priceDeltaCents), 0),
  };
}

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
  isAlcoholic: boolean;
  station: KitchenStation;
  groups: MenuGroup[];
};

/**
 * `halfToppingRule` picks how a half-and-half pie charges its toppings:
 * `average` charges each half topping `halfToppingPriceBps` of its whole-pie
 * price (5000 = half, so two different halves average out); `highest`
 * charges the dearer half in full and the other nothing. `extraToppingBps`
 * prices an extra portion as a multiple of the topping (20000 = 2×) unless
 * the modifier names its own extra price.
 */
export type PricingPolicy = {
  halfToppingRule: HalfToppingRule;
  halfToppingPriceBps: number;
  extraToppingBps: number;
};

export class PricingError extends Error {}

const roundHalfUp = (n: number) => Math.round(n);

export function applyBps(cents: number, bps: number): number {
  return roundHalfUp((cents * bps) / 10_000);
}

function portionWeight(prices: Prices, amount: Amount, policy: PricingPolicy): number {
  switch (amount) {
    case "none":
      return 0;
    case "light":
    case "regular":
      return prices.priceDeltaCents;
    case "extra":
      return prices.extraPriceDeltaCents ?? applyBps(prices.priceDeltaCents, policy.extraToppingBps);
  }
}

/** A default topping comes with the pie, so only what an extra portion adds over a regular one is charged. */
function amountWeight(prices: Prices, isDefault: boolean, amount: Amount, policy: PricingPolicy): number {
  const w = portionWeight(prices, amount, policy);
  return isDefault ? Math.max(0, w - prices.priceDeltaCents) : w;
}

/** How one item uses a shared group, from its `item_modifier_groups` row. Empty arrays leave the group as it is. */
export type ItemGroupOverrides = {
  /** Replace the group's defaults. */
  defaultModifierIds: readonly number[];
  hiddenModifierIds: readonly number[];
  soldOutModifierIds: readonly number[];
};

/**
 * The options an item offers from a shared group: its hidden ones gone (a
 * hidden default with them), its own sold-out ones unavailable, and its own
 * defaults in place of the group's.
 */
export function itemOptions<M extends { id: number; isDefault: boolean; isAvailable: boolean }>(
  mods: readonly M[],
  o: ItemGroupOverrides,
): M[] {
  return mods
    .filter((m) => !o.hiddenModifierIds.includes(m.id))
    .map((m) => ({
      ...m,
      isDefault: o.defaultModifierIds.length ? o.defaultModifierIds.includes(m.id) : m.isDefault,
      isAvailable: m.isAvailable && !o.soldOutModifierIds.includes(m.id),
    }));
}

/** Why an item can't use `o` on `group`, or null when it can. */
export function overridesProblem(
  group: { name: string; minSelect: number; modifiers: readonly { id: number }[] },
  o: ItemGroupOverrides,
): string | null {
  const ids = new Set(group.modifiers.map((m) => m.id));
  if ([...o.hiddenModifierIds, ...o.soldOutModifierIds].some((id) => !ids.has(id))) {
    return `An option marked on ${group.name} isn't in that group.`;
  }
  if (o.hiddenModifierIds.some((id) => o.defaultModifierIds.includes(id))) {
    return `This item comes with an option it doesn't offer in ${group.name}.`;
  }
  if (group.minSelect > 0 && group.modifiers.every((m) => o.hiddenModifierIds.includes(m.id))) {
    return `${group.name} is required, so this item must offer at least one of its options.`;
  }
  return null;
}

/** The size picked among `selections`, or null when there is none. */
export function chosenSize(groups: readonly MenuGroup[], selections: readonly Selection[]): number | null {
  const sizeIds = new Set(groups.filter((g) => g.role === "size").flatMap((g) => g.modifiers.map((m) => m.id)));
  return selections.find((s) => sizeIds.has(s.modifierId))?.modifierId ?? null;
}

/**
 * unit = base + Σ modifier.priceDeltaCents, where each snapshot carries what
 * it was charged at the chosen size's prices (`pricesAt`), whatever order
 * the size was picked in: an option its delta; a placed topping its weight w
 * (its delta, its extra price, or 0 for "none", less its delta when the item
 * comes with it) when whole, and for a half `applyBps(w, halfToppingPriceBps)`
 * under `average`, or under `highest` w on the dearer side (ties to the left)
 * and 0 on the other.
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

  const sizeId = chosenSize(item.groups, selections);

  const seen = new Set<number>();
  const counts = new Map<number, number>();
  const modifiers: LineModifier[] = [];
  const halves: { index: number; placement: "left" | "right"; weight: number }[] = [];
  let unitPriceCents = item.basePriceCents;

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

    const base = { modifierId: mod.id, groupName: group.name, modifierName: mod.name };
    const prices = pricesAt(mod, sizeId);
    if (isPlaceable(group.role)) {
      const w = amountWeight(prices, mod.isDefault, s.amount, policy);
      const charged = s.placement === "whole" ? w : policy.halfToppingRule === "average" ? applyBps(w, policy.halfToppingPriceBps) : 0;
      if (s.placement !== "whole") halves.push({ index: modifiers.length, placement: s.placement, weight: w });
      modifiers.push({ kind: "placed", role: group.role, placement: s.placement, amount: s.amount, priceDeltaCents: charged, ...base });
    } else {
      if (s.placement !== "whole" || s.amount !== "regular") {
        throw new PricingError(`${group.name} on "${item.name}" cannot be split or changed in amount.`);
      }
      modifiers.push({ kind: "option", role: group.role, priceDeltaCents: prices.priceDeltaCents, ...base });
    }
  }

  if (policy.halfToppingRule === "highest" && halves.length > 0) {
    const side = (p: "left" | "right") => halves.filter((h) => h.placement === p).reduce((n, h) => n + h.weight, 0);
    const dearer = side("left") >= side("right") ? "left" : "right";
    for (const h of halves) {
      if (h.placement === dearer) modifiers[h.index].priceDeltaCents = h.weight;
    }
  }
  for (const m of modifiers) unitPriceCents += m.priceDeltaCents;

  for (const group of item.groups) {
    const count = counts.get(group.id) ?? 0;
    if (count < group.minSelect) {
      throw new PricingError(`"${item.name}" requires a ${group.name} selection.`);
    }
    if (group.maxSelect !== null && count > group.maxSelect) {
      throw new PricingError(`Too many ${group.name} selections on "${item.name}".`);
    }
  }

  return { unitPriceCents, modifiers };
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
