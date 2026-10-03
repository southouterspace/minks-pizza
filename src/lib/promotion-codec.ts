/**
 * The operator form's model and both directions of its codec: a stored deal
 * into the form's strings (toDraft) and the form back into a PromotionInput
 * (fromDraft). Every number is the string being typed, so a half-typed "1."
 * doesn't fight the input. Plain module (not "use client") because server
 * pages build drafts from stored rows and tests round-trip them.
 */
import { zonedParts } from "./hours";
import type { PromotionTerms } from "./promotion-engine";
import type { MenuCatalog } from "./promotion-admin";
import {
  ANY_ITEM,
  sameTarget,
  type PromotionInput,
  type PromotionReward,
  type RewardType,
  type Target,
  type WeeklyWindow,
} from "./promotion-schema";

export type PromotionDraft = {
  name: string;
  description: string;
  trigger: "automatic" | "code";
  rewardType: RewardType;
  percent: string;
  amount: string;
  maxDiscount: string;
  price: string;
  maxUnits: string;
  target: Target;
  buyQty: string;
  getQty: string;
  getSameAsBuy: boolean;
  getTarget: Target;
  getPercent: string;
  maxApplications: string;
  minSubtotal: string;
  pickup: boolean;
  delivery: boolean;
  startsOn: string;
  endsOn: string;
  schedule: WeeklyWindow[];
  newCustomersOnly: boolean;
  perCustomerLimit: string;
  totalLimit: string;
  stackable: boolean;
  advertised: boolean;
  /** A shared code to create with the deal; only read on create. */
  code: string;
};

export const EMPTY_DRAFT: PromotionDraft = {
  name: "",
  description: "",
  trigger: "code",
  rewardType: "order_percent",
  percent: "10",
  amount: "5",
  maxDiscount: "",
  price: "12",
  maxUnits: "",
  target: ANY_ITEM,
  buyQty: "1",
  getQty: "1",
  getSameAsBuy: true,
  getTarget: ANY_ITEM,
  getPercent: "100",
  maxApplications: "",
  minSubtotal: "",
  pickup: true,
  delivery: true,
  startsOn: "",
  endsOn: "",
  schedule: [],
  newCustomersOnly: false,
  perCustomerLimit: "",
  totalLimit: "",
  stackable: false,
  advertised: true,
  code: "",
};

/** "12" for 1200, "12.5" for 1250: dollars from cents, percent from basis points. */
const fromHundredths = (n: number) => (n / 100).toFixed(2).replace(/\.00$/, "");
const toHundredths = (s: string) => Math.round(Number.parseFloat(s || "0") * 100);
const fromOptional = (n: number | null) => (n === null ? "" : String(n));
const toIntOrNull = (s: string) => (s.trim() === "" ? null : Number.parseInt(s, 10));

function rewardDraft(r: PromotionReward): Partial<PromotionDraft> {
  switch (r.type) {
    case "order_percent":
      return { rewardType: r.type, percent: String(r.percentBps / 100), maxDiscount: r.maxDiscountCents ? fromHundredths(r.maxDiscountCents) : "" };
    case "order_amount":
      return { rewardType: r.type, amount: fromHundredths(r.amountCents) };
    case "item_percent":
      return { rewardType: r.type, target: r.target, percent: String(r.percentBps / 100), maxUnits: fromOptional(r.maxUnits) };
    case "item_amount":
      return { rewardType: r.type, target: r.target, amount: fromHundredths(r.amountCents), maxUnits: fromOptional(r.maxUnits) };
    case "item_price":
      return { rewardType: r.type, target: r.target, price: fromHundredths(r.priceCents), maxUnits: fromOptional(r.maxUnits) };
    case "bogo":
      return {
        rewardType: r.type,
        target: r.buy.target,
        buyQty: String(r.buy.quantity),
        getQty: String(r.get.quantity),
        getSameAsBuy: sameTarget(r.buy.target, r.get.target),
        getTarget: r.get.target,
        getPercent: String(r.get.percentBps / 100),
        maxApplications: fromOptional(r.maxApplications),
      };
    case "free_delivery":
      return { rewardType: r.type };
  }
}

function rewardOf(d: PromotionDraft): PromotionReward {
  switch (d.rewardType) {
    case "order_percent":
      return { type: "order_percent", percentBps: toHundredths(d.percent), maxDiscountCents: d.maxDiscount.trim() === "" ? null : toHundredths(d.maxDiscount) };
    case "order_amount":
      return { type: "order_amount", amountCents: toHundredths(d.amount) };
    case "item_percent":
      return { type: "item_percent", target: d.target, percentBps: toHundredths(d.percent), maxUnits: toIntOrNull(d.maxUnits) };
    case "item_amount":
      return { type: "item_amount", target: d.target, amountCents: toHundredths(d.amount), maxUnits: toIntOrNull(d.maxUnits) };
    case "item_price":
      return { type: "item_price", target: d.target, priceCents: toHundredths(d.price), maxUnits: toIntOrNull(d.maxUnits) };
    case "bogo":
      return {
        type: "bogo",
        buy: { target: d.target, quantity: toIntOrNull(d.buyQty) ?? 0 },
        get: {
          target: d.getSameAsBuy ? d.target : d.getTarget,
          quantity: toIntOrNull(d.getQty) ?? 0,
          percentBps: toHundredths(d.getPercent),
        },
        maxApplications: toIntOrNull(d.maxApplications),
      };
    case "free_delivery":
      return { type: "free_delivery" };
  }
}

/** The stored deal back into the form's strings; days on the store's calendar. */
export function toDraft(p: PromotionTerms & { description: string | null; advertised: boolean }, tz: string): PromotionDraft {
  return {
    ...EMPTY_DRAFT,
    ...rewardDraft(p.reward),
    name: p.name,
    description: p.description ?? "",
    trigger: p.trigger,
    minSubtotal: p.minSubtotalCents ? fromHundredths(p.minSubtotalCents) : "",
    pickup: p.orderTypes.includes("pickup"),
    delivery: p.orderTypes.includes("delivery"),
    startsOn: p.startsAt ? zonedParts(p.startsAt, tz).date : "",
    endsOn: p.endsAt ? zonedParts(new Date(p.endsAt.getTime() - 1), tz).date : "",
    schedule: p.schedule ?? [],
    newCustomersOnly: p.newCustomersOnly,
    perCustomerLimit: fromOptional(p.perCustomerLimit),
    totalLimit: fromOptional(p.totalLimit),
    stackable: p.stackable,
    advertised: p.advertised,
  };
}

/** The form's strings as the input promotionInputSchema validates. */
export function fromDraft(d: PromotionDraft): PromotionInput {
  return {
    name: d.name,
    description: d.description.trim() || null,
    trigger: d.trigger,
    reward: rewardOf(d),
    minSubtotalCents: toHundredths(d.minSubtotal),
    orderTypes: [...(d.pickup ? (["pickup"] as const) : []), ...(d.delivery ? (["delivery"] as const) : [])],
    startsOn: d.startsOn || null,
    endsOn: d.endsOn || null,
    schedule: d.schedule,
    newCustomersOnly: d.newCustomersOnly,
    perCustomerLimit: toIntOrNull(d.perCustomerLimit),
    totalLimit: toIntOrNull(d.totalLimit),
    stackable: d.stackable,
    advertised: d.advertised,
  };
}

export type PromotionTemplate = { label: string; draft: PromotionDraft };

/** Quick starts, written as rewards so they go through the same codec as a saved deal. */
export function promotionTemplates(catalog: MenuCatalog): PromotionTemplate[] {
  // The size most deals target; "X-Large" also contains "large".
  const large = catalog.modifierGroups.flatMap((g) => g.modifiers).find((m) => /large/i.test(m.name) && !/x-?large/i.test(m.name));
  const larges: Target = { ...ANY_ITEM, modifierIds: large ? [large.id] : [] };
  const template = (label: string, reward: PromotionReward, over: Partial<PromotionDraft>): PromotionTemplate => ({
    label,
    draft: { ...EMPTY_DRAFT, ...rewardDraft(reward), ...over },
  });
  return [
    template("Percent off order", { type: "order_percent", percentBps: 1000, maxDiscountCents: null }, { name: "10% off your order", trigger: "code" }),
    template("$ off order", { type: "order_amount", amountCents: 500 }, { name: "$5 off orders $25+", trigger: "code", minSubtotal: "25" }),
    template(
      "BOGO",
      { type: "bogo", buy: { target: larges, quantity: 1 }, get: { target: larges, quantity: 1, percentBps: 10_000 }, maxApplications: null },
      { name: "Buy one large, get one free", trigger: "automatic" },
    ),
    template("Item deal price", { type: "item_price", target: larges, priceCents: 1200, maxUnits: null }, { name: "Any large pizza $12", trigger: "automatic" }),
    template("Free delivery", { type: "free_delivery" }, { name: "Free delivery on $30+", trigger: "automatic", minSubtotal: "30", pickup: false, delivery: true }),
    template("Happy hour", { type: "order_percent", percentBps: 2000, maxDiscountCents: null }, {
      name: "Happy hour: 20% off",
      trigger: "automatic",
      schedule: [{ days: [1, 2, 3, 4, 5], start: "15:00", end: "17:00" }],
    }),
  ];
}
