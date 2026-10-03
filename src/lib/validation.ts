import { z } from "zod";
import type {
  Approval,
  CustomerInput,
  FirePlan,
  Fulfillment,
  OrderMutation,
  SubmitLine,
  SubmitOrderRequest,
  TenderInput,
} from "@/lib/orders";
import { AMOUNTS, PLACEMENTS, type Selection } from "@/lib/pricing";
import { pinSchema } from "@/lib/timeclock";

const id = z.number().int().positive();
const cents = z.number().int().min(0).max(10_000_000);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

const selectionSchema: z.ZodType<Selection> = z.object({
  modifierId: id,
  placement: z.enum(PLACEMENTS).default("whole"),
  amount: z.enum(AMOUNTS).default("regular"),
});

const lineFields = {
  itemId: id,
  quantity: z.number().int().min(1).max(50),
  notes: optionalText(500),
};

/**
 * A storefront cart line. Older clients still post earlier shapes: carts from
 * before halves existed send `modifierIds` (whole, regular selections), and
 * the topping-inventory storefront sent `modifiers` as id/placement/portion.
 */
export const cartLineSchema = z.union([
  z.object({ ...lineFields, selections: z.array(selectionSchema).max(50) }),
  z
    .object({
      ...lineFields,
      modifiers: z
        .array(
          z.object({
            id,
            placement: z.enum(PLACEMENTS).default("whole"),
            portion: z.enum(["light", "regular", "extra"]).default("regular"),
          }),
        )
        .max(50),
    })
    .transform(({ modifiers, ...line }) => ({
      ...line,
      selections: modifiers.map(({ id: modifierId, placement, portion }): Selection => ({ modifierId, placement, amount: portion })),
    })),
  z
    .object({ ...lineFields, modifierIds: z.array(id).max(50) })
    .transform(({ modifierIds, ...line }) => ({
      ...line,
      selections: modifierIds.map((modifierId): Selection => ({ modifierId, placement: "whole", amount: "regular" })),
    })),
]);

export type CartLineInput = z.infer<typeof cartLineSchema>;

/** Codes as the customer typed them; matching normalizes. */
const promoCodesSchema = z.array(z.string().trim().min(1).max(40)).max(5).optional();

const phoneSchema = z
  .string()
  .trim()
  .min(7, "Enter a valid phone number")
  .max(25)
  .regex(/^[\d\s()+.-]+$/, "Enter a valid phone number")
  .refine((s) => s.replace(/\D/g, "").length >= 7, "Enter a valid phone number");

const rewardIdSchema = z.number().int().positive().nullable().optional();

/** What the cart and checkout send for a live quote; the phone may be half-typed. */
export const previewSchema = z.object({
  orderType: z.enum(["pickup", "delivery"]),
  customerPhone: z.string().max(25).optional(),
  promoCodes: promoCodesSchema,
  rewardId: rewardIdSchema,
  /** Also list the signed-in member's rewards and whether each fits the cart. */
  withRewards: z.boolean().optional(),
  lines: z.array(cartLineSchema).max(50),
});

export type PreviewInput = z.infer<typeof previewSchema>;

export const checkoutSchema = z
  .object({
    orderType: z.enum(["pickup", "delivery"]),
    customerName: z.string().trim().min(1, "Name is required").max(120),
    customerPhone: phoneSchema,
    customerEmail: z
      .string()
      .trim()
      .email("Enter a valid email")
      .max(200)
      .optional()
      .or(z.literal("")),
    addressLine1: z.string().trim().max(200).optional(),
    addressLine2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(100).optional(),
    zip: z.string().trim().max(20).optional(),
    orderNotes: z.string().trim().max(1000).optional(),
    tipCents: z.number().int().min(0).max(50_000),
    lines: z.array(cartLineSchema).min(1, "Your cart is empty").max(50),
    promoCodes: promoCodesSchema,
    /** The total the customer saw on the button; a mismatch refuses the order. */
    expectedTotalCents: z.number().int().min(0).optional(),
    joinLoyalty: z.boolean().optional(),
    rewardId: rewardIdSchema,
  })
  .superRefine((data, ctx) => {
    if (data.orderType === "delivery") {
      if (!data.addressLine1?.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["addressLine1"],
          message: "Delivery address is required",
        });
      }
      if (!data.zip?.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["zip"],
          message: "ZIP code is required",
        });
      }
    }
  });

export type CheckoutInput = z.infer<typeof checkoutSchema>;

// ---------------------------------------------------------------------------
// POS wire shapes
// ---------------------------------------------------------------------------

const submitLineSchema: z.ZodType<SubmitLine> = z.object({
  lineId: z.uuid(),
  ...lineFields,
  selections: z.array(selectionSchema).max(50),
});

const fulfillmentSchema: z.ZodType<Fulfillment> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pickup") }),
  z.object({
    kind: z.literal("delivery"),
    address: z.object({
      line1: z.string().trim().min(1).max(200),
      line2: optionalText(200),
      city: optionalText(100),
      zip: z.string().trim().min(1).max(20),
    }),
  }),
  z.object({ kind: z.literal("dine_in"), table: z.string().trim().min(1).max(20) }),
]);

const customerSchema: z.ZodType<CustomerInput> = z.object({
  phone: z.string().trim().regex(/^[\d\s()+.-]{7,25}$/, "Enter a valid phone number"),
  name: z.string().trim().min(1).max(120),
  email: z.email().max(200).nullish().transform((v) => v ?? null),
  saveAddress: z.boolean().default(false),
});

const tenderSchema: z.ZodType<TenderInput> = z.object({
  id: z.uuid(),
  method: z.enum(["cash", "card_external"]),
  amountCents: cents,
  tenderedCents: cents.nullish().transform((v) => v ?? null),
  tipCents: cents.default(0),
  last4: z
    .string()
    .regex(/^\d{4}$/)
    .nullish()
    .transform((v) => v ?? null),
});

const isoTime = z.iso.datetime({ offset: true });

const firePlanSchema: z.ZodType<FirePlan> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("now") }),
  z.object({ kind: z.literal("hold") }),
  z.object({ kind: z.literal("at"), at: isoTime }),
]);

export const submitOrderSchema: z.ZodType<SubmitOrderRequest> = z.object({
  orderId: z.uuid(),
  source: z.enum(["web", "walk_in", "phone"]),
  fulfillment: fulfillmentSchema,
  customer: customerSchema.nullable(),
  notes: optionalText(1000),
  fire: firePlanSchema,
  promisedAt: isoTime.nullish().transform((v) => v ?? null),
  tipCents: cents.default(0),
  lines: z.array(submitLineSchema).min(1).max(100),
  tenders: z.array(tenderSchema).max(10).default([]),
});

const reason = z.string().trim().min(1, "A reason is required").max(200);

export const orderMutationSchema: z.ZodType<OrderMutation> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add_lines"), lines: z.array(submitLineSchema).min(1).max(100), fire: z.boolean() }),
  z.object({ kind: z.literal("fire"), lineIds: z.union([z.literal("all"), z.array(z.uuid()).min(1)]) }),
  z.object({ kind: z.literal("void_line"), lineId: z.uuid(), reason }),
  z.object({ kind: z.literal("discount"), id: z.uuid(), lineId: z.uuid().nullable(), cents: cents.min(1), reason }),
  z.object({ kind: z.literal("remove_discount"), discountId: id }),
  z.object({ kind: z.literal("comp"), id: z.uuid(), lineId: z.uuid(), reason }),
  z.object({ kind: z.literal("tender"), tender: tenderSchema }),
  z.object({
    kind: z.literal("refund"),
    id: z.uuid(),
    method: z.enum(["cash", "card_external"]),
    amountCents: cents.min(1),
    reason,
  }),
  z.object({ kind: z.literal("set_customer"), customer: customerSchema }),
  z.object({ kind: z.literal("set_fulfillment"), fulfillment: fulfillmentSchema }),
  z.object({
    kind: z.literal("set_schedule"),
    fire: firePlanSchema,
    promisedAt: isoTime.nullish().transform((v) => v ?? null),
  }),
  z.object({ kind: z.literal("cancel"), reason }),
  z.object({ kind: z.literal("split_by_item"), lineIds: z.array(z.uuid()).min(1), newOrderId: z.uuid() }),
  z.object({ kind: z.literal("handoff") }),
]);

const approvalSchema: z.ZodType<Approval> = z.object({ managerPin: pinSchema });

export const mutateOrderSchema = z.object({
  orderId: z.uuid(),
  mutation: orderMutationSchema,
  approval: approvalSchema.optional(),
});

export const openShiftSchema = z.object({ shiftId: z.uuid(), startingBankCents: cents });

export const closeShiftSchema = z.object({
  shiftId: z.uuid(),
  countedCashCents: cents,
  cardBatchCents: cents,
  declaredCashTipsCents: cents,
  notes: optionalText(1000),
  approval: approvalSchema.optional(),
});

export const drawerEventSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["no_sale", "paid_in", "paid_out"]),
  cents: cents.default(0),
  reason: optionalText(200),
  approval: approvalSchema.optional(),
});

const comp = {
  reason: z
    .string()
    .trim()
    .min(1, "Say why: the reason shows on the receipt.")
    .transform((s) => s.slice(0, 120)),
  value: z
    .string()
    .transform(Number)
    .refine((n) => Number.isFinite(n) && n > 0, "Enter an amount above zero."),
  promotionId: z.union([z.literal("").transform(() => null), z.string().transform(Number).pipe(z.number().int().positive())]),
};

/** An operator comp from the order page's form: dollars or a percent off the items. */
export const compSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("amount"), ...comp }),
    z.object({ kind: z.literal("percent"), ...comp, value: comp.value.refine((n) => n <= 100, "Percent must be 1–100.") }),
  ])
  .transform((c) => ({
    label: c.reason,
    promotionId: c.promotionId,
    amount: c.kind === "percent" ? { percentBps: Math.round(c.value * 100) } : { cents: Math.round(c.value * 100) },
  }));
