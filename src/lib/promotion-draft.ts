/**
 * The operator form's state: every number as the string being typed, so a
 * half-typed "1." doesn't fight the input. Plain module (not "use client")
 * because server pages build drafts from stored rows.
 */
import { zonedParts } from "./hours";
import { ANY_ITEM, type PromotionTerms, type RewardType, type Target, type WeeklyWindow } from "./promotions";

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

const dollars = (c: number) => (c / 100).toFixed(2).replace(/\.00$/, "");
const optional = (n: number | null) => (n === null ? "" : String(n));

/** The stored deal back into the form's strings; days on the store's calendar. */
export function toDraft(p: PromotionTerms & { description: string | null; advertised: boolean }, tz: string): PromotionDraft {
  const r = p.reward;
  const d: PromotionDraft = {
    ...EMPTY_DRAFT,
    name: p.name,
    description: p.description ?? "",
    trigger: p.trigger,
    rewardType: r.type,
    minSubtotal: p.minSubtotalCents ? dollars(p.minSubtotalCents) : "",
    pickup: p.orderTypes.includes("pickup"),
    delivery: p.orderTypes.includes("delivery"),
    startsOn: p.startsAt ? zonedParts(p.startsAt, tz).date : "",
    endsOn: p.endsAt ? zonedParts(new Date(p.endsAt.getTime() - 1), tz).date : "",
    schedule: p.schedule ?? [],
    newCustomersOnly: p.newCustomersOnly,
    perCustomerLimit: optional(p.perCustomerLimit),
    totalLimit: optional(p.totalLimit),
    stackable: p.stackable,
    advertised: p.advertised,
  };
  switch (r.type) {
    case "order_percent":
      return { ...d, percent: String(r.percentBps / 100), maxDiscount: r.maxDiscountCents ? dollars(r.maxDiscountCents) : "" };
    case "order_amount":
      return { ...d, amount: dollars(r.amountCents) };
    case "item_percent":
      return { ...d, target: r.target, percent: String(r.percentBps / 100), maxUnits: optional(r.maxUnits) };
    case "item_amount":
      return { ...d, target: r.target, amount: dollars(r.amountCents), maxUnits: optional(r.maxUnits) };
    case "item_price":
      return { ...d, target: r.target, price: dollars(r.priceCents), maxUnits: optional(r.maxUnits) };
    case "bogo":
      return {
        ...d,
        target: r.buy.target,
        buyQty: String(r.buy.quantity),
        getQty: String(r.get.quantity),
        getSameAsBuy: JSON.stringify(r.buy.target) === JSON.stringify(r.get.target),
        getTarget: r.get.target,
        getPercent: String(r.get.percentBps / 100),
        maxApplications: optional(r.maxApplications),
      };
    case "free_delivery":
      return d;
  }
}

