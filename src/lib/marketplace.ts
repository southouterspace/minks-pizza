/**
 * The seam for orders placed on a delivery marketplace. Intake is
 * partner-gated (docs/delivery-platforms-research.md, Part A), so there are
 * no adapters yet: one would parse its platform's payload into ExternalOrder.
 */
import type { OrderItemModifier, orderItems, orders } from "@/db/schema";
import type { KitchenStation } from "@/lib/kds";

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
    modifiers: OrderItemModifier[];
    notes: string | null;
  }[];
  subtotalCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  tipCents: number;
  totalCents: number;
};

export function externalOrderRows(
  order: ExternalOrder,
  stationByItemId: ReadonlyMap<number, KitchenStation>,
): {
  order: typeof orders.$inferInsert;
  items: Omit<typeof orderItems.$inferInsert, "orderId">[];
} {
  return {
    order: {
      source: order.source,
      sourceOrderId: order.sourceOrderId,
      sourceDisplayId: order.sourceDisplayId,
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
      deliveryFeeCents: order.deliveryFeeCents,
      tipCents: order.tipCents,
      totalCents: order.totalCents,
      // The marketplace collected the money.
      paymentStatus: "paid",
    },
    items: order.lines.map((line) => {
      const station =
        line.merchantItemId === null ? undefined : stationByItemId.get(line.merchantItemId);
      return {
        // An id the map doesn't know is a deleted or foreign item; linking it
        // would violate the menu item foreign key.
        menuItemId: station === undefined ? null : line.merchantItemId,
        itemName: line.name,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        lineTotalCents: line.unitPriceCents * line.quantity,
        modifiers: line.modifiers,
        notes: line.notes,
        station: station ?? "kitchen",
      };
    }),
  };
}
