import { z } from "zod";

export const cartLineSchema = z.object({
  itemId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(50),
  modifierIds: z.array(z.number().int().positive()).max(50),
  notes: z.string().trim().max(500).optional(),
});

export const checkoutSchema = z
  .object({
    orderType: z.enum(["pickup", "delivery"]),
    customerName: z.string().trim().min(1, "Name is required").max(120),
    customerPhone: z
      .string()
      .trim()
      .min(7, "Enter a valid phone number")
      .max(25)
      .regex(/^[\d\s()+.-]+$/, "Enter a valid phone number"),
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
export type CartLineInput = z.infer<typeof cartLineSchema>;
