/**
 * The seam for orders placed on a delivery marketplace. Intake is
 * partner-gated (docs/delivery-platforms-research.md, Part A), so there are
 * no adapters yet: one would parse its platform's payload into ExternalOrder.
 */
import type { orderItems, orders, tenders } from "@/db/schema";
import type { KitchenStation } from "@/lib/kds";
import type { LineModifier } from "@/lib/pricing";

export type ExternalOrder = {
  source: "doordash" | "ubereats" | "grubhub";
  sourceOrderId: string;
  sourceDisplayId: string;
  orderType: "pickup" | "delivery";
  customerName: string;
  customerPhone: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  zip: string | null;
  notes: string | null;
  lines: {
    /** We push our menu item ids to the marketplace as the merchant-supplied id. */
    merchantItemId: number | null;
    name: string;
    quantity: number;
    unitPriceCents: number;
    /** Names only: a marketplace's modifiers are not ours. */
    modifiers: { groupName: string; modifierName: string; priceDeltaCents: number }[];
    notes: string | null;
  }[];
  subtotalCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  tipCents: number;
  totalCents: number;
};

/**
 * Our rows for a marketplace order. The platform priced, taxed and collected
 * it, so the money columns are copied (the fold leaves marketplace totals
 * alone) and the payment is one `marketplace` tender for the total. The tax
 * rate is implied, to the basis point, for the record.
 */
export function externalOrderRows(
  order: ExternalOrder,
  menuItemsById: ReadonlyMap<number, { station: KitchenStation; isAlcoholic: boolean }>,
): {
  order: typeof orders.$inferInsert;
  items: Omit<typeof orderItems.$inferInsert, "orderId">[];
  tender: Omit<typeof tenders.$inferInsert, "orderId" | "id">;
} {
  return {
    order: {
      source: order.source,
      sourceOrderId: order.sourceOrderId,
      sourceDisplayId: order.sourceDisplayId,
      status: "held",
      orderType: order.orderType,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      addressLine1: order.addressLine1,
      addressLine2: order.addressLine2,
      city: order.city,
      zip: order.zip,
      orderNotes: order.notes,
      subtotalCents: order.subtotalCents,
      taxCents: order.taxCents,
      taxRateBps: order.subtotalCents > 0 ? Math.round((order.taxCents * 10_000) / order.subtotalCents) : 0,
      deliveryFeeCents: order.deliveryFeeCents,
      tipCents: order.tipCents,
      totalCents: order.totalCents,
      paidCents: order.totalCents,
    },
    items: order.lines.map((line) => {
      const known = line.merchantItemId === null ? undefined : menuItemsById.get(line.merchantItemId);
      return {
        // An id the map doesn't know is a deleted or foreign item; linking it
        // would violate the menu item foreign key.
        menuItemId: known === undefined ? null : line.merchantItemId,
        itemName: line.name,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        lineTotalCents: line.unitPriceCents * line.quantity,
        modifiers: line.modifiers.map(
          (m): LineModifier => ({ kind: "option", modifierId: null, role: "option", ...m }),
        ),
        notes: line.notes,
        station: known?.station ?? "kitchen",
        isAlcoholic: known?.isAlcoholic ?? false,
      };
    }),
    tender: {
      direction: "payment",
      method: "marketplace",
      amountCents: order.totalCents,
      tipCents: 0,
    },
  };
}
