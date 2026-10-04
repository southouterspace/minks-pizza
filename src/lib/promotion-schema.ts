/**
 * Promotions as stored and as the operator submits them: the reward union,
 * its zod schemas, and REWARD_SCOPE, which part of the order each reward
 * type discounts. Money is integer cents, percentages are
 * basis points (2000 = 20%).
 */
import { z } from "zod";
import { zonedDayStart } from "./hours";

export const PROMOTION_TRIGGERS = ["automatic", "code"] as const;
export type PromotionTrigger = (typeof PROMOTION_TRIGGERS)[number];

export const ORDER_TYPES = ["pickup", "delivery"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const DISCOUNT_TARGETS = ["items", "delivery"] as const;
export type DiscountTarget = (typeof DISCOUNT_TARGETS)[number];

export const DISCOUNT_SOURCES = ["promotion", "comp", "loyalty"] as const;
export type DiscountSource = (typeof DISCOUNT_SOURCES)[number];

const id = z.number().int().positive();
const cents = z.number().int().min(1).max(1_000_000);
const percentBps = z.number().int().min(100, "Percent must be 1–100").max(10_000, "Percent must be 1–100");
const units = z.number().int().min(1).max(100).nullable();

/**
 * A line qualifies when (categoryIds empty or its category is listed) and
 * (itemIds empty or its item is listed) and (modifierIds empty or it carries
 * one of them, e.g. the "Large" size). All empty means any item.
 */
export const targetSchema = z.object({
  categoryIds: z.array(id).max(100),
  itemIds: z.array(id).max(500),
  modifierIds: z.array(id).max(100),
});
export type Target = z.infer<typeof targetSchema>;

export const ANY_ITEM: Target = { categoryIds: [], itemIds: [], modifierIds: [] };

export const promotionRewardSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("order_percent"), percentBps, maxDiscountCents: cents.nullable() }),
  z.object({ type: z.literal("order_amount"), amountCents: cents }),
  z.object({ type: z.literal("item_percent"), target: targetSchema, percentBps, maxUnits: units }),
  z.object({ type: z.literal("item_amount"), target: targetSchema, amountCents: cents, maxUnits: units }),
  z.object({
    type: z.literal("item_price"),
    target: targetSchema,
    priceCents: z.number().int().min(0).max(1_000_000),
    maxUnits: units,
  }),
  z.object({
    type: z.literal("bogo"),
    buy: z.object({ target: targetSchema, quantity: z.number().int().min(1).max(20) }),
    get: z.object({ target: targetSchema, quantity: z.number().int().min(1).max(20), percentBps }),
    maxApplications: units,
  }),
  z.object({
    type: z.literal("bundle"),
    target: targetSchema,
    quantity: z.number().int().min(2, "A bundle needs at least 2 items").max(20),
    /** Each item's deal price, covering its options and the first `includedToppings` toppings. */
    priceCents: z.number().int().min(0).max(1_000_000),
    /** Null = every topping included. */
    includedToppings: z.number().int().min(0).max(20).nullable(),
    maxApplications: units,
  }),
  z.object({ type: z.literal("free_delivery") }),
]);
export type PromotionReward = z.infer<typeof promotionRewardSchema>;
export type RewardType = PromotionReward["type"];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const weeklyWindowSchema = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).min(1, "Pick at least one day").max(7),
    start: z.string().regex(HHMM),
    end: z.string().regex(HHMM),
  })
  .refine((w) => w.start !== w.end, "A time window needs different start and end times");
/** `days`: 0 = Sunday. An end at or before the start runs past midnight. */
export type WeeklyWindow = z.infer<typeof weeklyWindowSchema>;

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date")
  .nullable();

/** What the operator's form submits; dates are store-local days, both inclusive. */
export const promotionInputSchema = z
  .object({
    name: z.string().trim().min(1, "Give the deal a name customers will see").max(80),
    description: z.string().trim().max(500).nullable(),
    trigger: z.enum(PROMOTION_TRIGGERS),
    reward: promotionRewardSchema,
    minSubtotalCents: z.number().int().min(0).max(1_000_000),
    orderTypes: z.array(z.enum(ORDER_TYPES)).min(1, "Pick pickup, delivery or both").max(2),
    startsOn: day,
    endsOn: day,
    schedule: z.array(weeklyWindowSchema).max(14),
    newCustomersOnly: z.boolean(),
    perCustomerLimit: z.number().int().min(1, "Limits must be at least 1").max(1000).nullable(),
    totalLimit: z.number().int().min(1, "Limits must be at least 1").max(1_000_000).nullable(),
    stackable: z.boolean(),
    advertised: z.boolean(),
  })
  .refine((p) => !p.startsOn || !p.endsOn || p.endsOn >= p.startsOn, {
    message: "The end date must be on or after the start date",
    path: ["endsOn"],
  })
  .refine((p) => REWARD_SCOPE[p.reward.type] !== "delivery" || (p.orderTypes.length === 1 && p.orderTypes[0] === "delivery"), {
    message: "Free delivery is for delivery orders only",
    path: ["orderTypes"],
  });
export type PromotionInput = z.infer<typeof promotionInputSchema>;

/** Form input to stored columns: days become instants on the store's clock. */
export function promotionColumns(input: PromotionInput, timezone: string) {
  const { startsOn, endsOn, ...rest } = input;
  const nextDay = (d: string) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString().slice(0, 10);
  };
  return {
    ...rest,
    description: rest.description || null,
    schedule: rest.schedule.length ? rest.schedule : null,
    startsAt: startsOn ? zonedDayStart(startsOn, timezone) : null,
    endsAt: endsOn ? zonedDayStart(nextDay(endsOn), timezone) : null,
  };
}

export function sameTarget(a: Target, b: Target): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Which part of the order a reward discounts; item rewards apply first, delivery last. */
export type RewardScope = "item" | "order" | "delivery";

/**
 * Which part of the order each reward discounts. Adding a type means a
 * schema variant, an applyReward case, its copy, a row here and a row in
 * the form's REWARD_FORM.
 */
export const REWARD_SCOPE = {
  order_percent: "order",
  order_amount: "order",
  item_percent: "item",
  item_amount: "item",
  item_price: "item",
  bogo: "item",
  bundle: "item",
  free_delivery: "delivery",
} as const satisfies Record<RewardType, RewardScope>;

export const REWARD_TYPES = Object.keys(REWARD_SCOPE) as RewardType[];

type OrderRewardType = {
  [K in RewardType]: (typeof REWARD_SCOPE)[K] extends "order" ? K : never;
}[RewardType];
/** A whole-order reward, the kind an operator can also comp by hand. */
export type OrderReward = Extract<PromotionReward, { type: OrderRewardType }>;

export function isOrderReward(r: PromotionReward): r is OrderReward {
  return REWARD_SCOPE[r.type] === "order";
}
