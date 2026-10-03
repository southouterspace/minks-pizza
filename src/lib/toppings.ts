/**
 * Topping choices: which modifier groups behave as sizes or toppings, the
 * half/portion options a topping can carry, what each costs the customer and
 * how much of the recipe it uses. Shared by server and client — no I/O.
 */

export const MODIFIER_GROUP_KINDS = ["choice", "size", "toppings"] as const;
export type ModifierGroupKind = (typeof MODIFIER_GROUP_KINDS)[number];

export const GROUP_KIND_LABEL: Record<ModifierGroupKind, string> = {
  choice: "Choice",
  size: "Size",
  toppings: "Toppings",
};

export const PLACEMENTS = ["whole", "left", "right"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export const PORTIONS = ["light", "regular", "extra"] as const;
export type Portion = (typeof PORTIONS)[number];

export const PLACEMENT_LABEL: Record<Placement, string> = {
  whole: "Whole",
  left: "Left half",
  right: "Right half",
};

export const PORTION_LABEL: Record<Portion, string> = {
  light: "Light",
  regular: "Regular",
  extra: "Extra",
};

export type ToppingChoice = { placement: Placement; portion: Portion };

export const DEFAULT_CHOICE: ToppingChoice = { placement: "whole", portion: "regular" };

export type ToppingPriceSettings = { halfToppingPriceBps: number };

export type PortionSettings = {
  halfPortionBps: number;
  lightPortionBps: number;
  extraPortionBps: number;
};

/** The store_settings column defaults, for when the settings row is missing. */
export const DEFAULT_PORTIONS: PortionSettings = {
  halfPortionBps: 5000,
  lightPortionBps: 5000,
  extraPortionBps: 15000,
};

/** Round half up to a whole cent after a basis-point multiply. */
function applyBps(cents: number, bps: number): number {
  return Math.floor((cents * bps + 5_000) / 10_000);
}

/**
 * What the customer pays for one topping selection. Light costs the regular
 * price; extra uses the modifier's extra price (callers only offer extra when
 * it is set); a half pays the store's half-topping share.
 */
export function toppingPriceCents(
  mod: { priceDeltaCents: number; extraPriceDeltaCents: number | null },
  choice: ToppingChoice,
  settings: ToppingPriceSettings,
): number {
  const base =
    choice.portion === "extra" && mod.extraPriceDeltaCents !== null
      ? mod.extraPriceDeltaCents
      : mod.priceDeltaCents;
  return choice.placement === "whole" ? base : applyBps(base, settings.halfToppingPriceBps);
}

/** How much of the topping's recipe one selection uses, in basis points (10000 = all of it). */
export function selectionFactorBps(choice: ToppingChoice, settings: PortionSettings): number {
  const placement = choice.placement === "whole" ? 10_000 : settings.halfPortionBps;
  const portion =
    choice.portion === "light"
      ? settings.lightPortionBps
      : choice.portion === "extra"
        ? settings.extraPortionBps
        : 10_000;
  return (placement * portion) / 10_000;
}

/** "Pepperoni (left half, extra)" for tickets and receipts; the bare name when nothing is chosen. */
export function describeChoice(name: string, choice: Partial<ToppingChoice>): string {
  const parts: string[] = [];
  if (choice.placement && choice.placement !== "whole") {
    parts.push(PLACEMENT_LABEL[choice.placement].toLowerCase());
  }
  if (choice.portion && choice.portion !== "regular") {
    parts.push(PORTION_LABEL[choice.portion].toLowerCase());
  }
  return parts.length ? `${name} (${parts.join(", ")})` : name;
}
