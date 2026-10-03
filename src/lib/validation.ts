import { z } from "zod";
import { PLACEMENTS, PORTIONS } from "@/lib/toppings";

export const cartModifierSchema = z.object({
  id: z.number().int().positive(),
  placement: z.enum(PLACEMENTS).optional(),
  portion: z.enum(PORTIONS).optional(),
});

export const cartLineSchema = z.object({
  itemId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(50),
  modifiers: z.array(cartModifierSchema).max(50),
  notes: z.string().trim().max(500).optional(),
});

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
export type CartLineInput = z.infer<typeof cartLineSchema>;
