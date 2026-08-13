import { eq, inArray } from "drizzle-orm";
import {
  db,
  itemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
  orderItems,
  orders,
  storeSettings,
  type OrderItemModifier,
} from "@/db";
import { taxFromBps } from "@/lib/money";
import type { CheckoutInput } from "@/lib/validation";

export type PricedLine = {
  itemId: number;
  itemName: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  modifiers: OrderItemModifier[];
  notes?: string;
};

export type PricedCart = {
  lines: PricedLine[];
  subtotalCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  totalCents: number; // before tip
};

export class OrderError extends Error {}

export async function getSettings() {
  const [settings] = await db
    .select()
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  if (!settings) throw new OrderError("Store is not configured yet.");
  return settings;
}

/**
 * Server-side pricing: the client's cart carries only ids + quantities; every
 * price comes from the database here. Also enforces availability and modifier
 * group min/max rules.
 */
export async function priceCart(
  lines: CheckoutInput["lines"],
  orderType: "pickup" | "delivery",
): Promise<PricedCart> {
  const settings = await getSettings();

  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const items = await db
    .select()
    .from(menuItems)
    .where(inArray(menuItems.id, itemIds));
  const itemById = new Map(items.map((i) => [i.id, i]));

  const links = itemIds.length
    ? await db
        .select()
        .from(itemModifierGroups)
        .where(inArray(itemModifierGroups.itemId, itemIds))
    : [];
  const groupIds = [...new Set(links.map((l) => l.groupId))];
  const groups = groupIds.length
    ? await db
        .select()
        .from(modifierGroups)
        .where(inArray(modifierGroups.id, groupIds))
    : [];
  const mods = groupIds.length
    ? await db
        .select()
        .from(modifiers)
        .where(inArray(modifiers.groupId, groupIds))
    : [];
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const modById = new Map(mods.map((m) => [m.id, m]));

  const priced: PricedLine[] = lines.map((line) => {
    const item = itemById.get(line.itemId);
    if (!item || !item.isAvailable) {
      throw new OrderError(
        `"${item?.name ?? "An item"}" is no longer available. Please remove it from your cart.`,
      );
    }

    const allowedGroupIds = new Set(
      links.filter((l) => l.itemId === item.id).map((l) => l.groupId),
    );

    const chosen: OrderItemModifier[] = [];
    const countByGroup = new Map<number, number>();
    let unitPrice = item.basePriceCents;

    for (const modId of line.modifierIds) {
      const mod = modById.get(modId);
      const group = mod ? groupById.get(mod.groupId) : undefined;
      if (!mod || !group || !allowedGroupIds.has(mod.groupId) || !mod.isAvailable) {
        throw new OrderError(
          `An option on "${item.name}" is no longer available. Please re-add it to your cart.`,
        );
      }
      chosen.push({
        groupName: group.name,
        modifierName: mod.name,
        priceDeltaCents: mod.priceDeltaCents,
      });
      countByGroup.set(mod.groupId, (countByGroup.get(mod.groupId) ?? 0) + 1);
      unitPrice += mod.priceDeltaCents;
    }

    for (const groupId of allowedGroupIds) {
      const group = groupById.get(groupId);
      if (!group) continue;
      const count = countByGroup.get(groupId) ?? 0;
      if (count < group.minSelect) {
        throw new OrderError(
          `"${item.name}" requires a ${group.name} selection.`,
        );
      }
      if (group.maxSelect !== null && count > group.maxSelect) {
        throw new OrderError(
          `Too many ${group.name} selections on "${item.name}".`,
        );
      }
    }

    return {
      itemId: item.id,
      itemName: item.name,
      quantity: line.quantity,
      unitPriceCents: unitPrice,
      lineTotalCents: unitPrice * line.quantity,
      modifiers: chosen,
      notes: line.notes,
    };
  });

  const subtotalCents = priced.reduce((sum, l) => sum + l.lineTotalCents, 0);
  const deliveryFeeCents =
    orderType === "delivery" ? settings.deliveryFeeCents : 0;
  const taxCents = taxFromBps(subtotalCents, settings.taxRateBps);

  return {
    lines: priced,
    subtotalCents,
    taxCents,
    deliveryFeeCents,
    totalCents: subtotalCents + taxCents + deliveryFeeCents,
  };
}

/**
 * Creates an order (payment_status = 'pending').
 *
 * STRIPE SEAM: when payments land, create a PaymentIntent for
 * `totalCents` here (or in a wrapping action), store its id on the order,
 * and flip payment_status to 'paid' from the Stripe webhook. Everything
 * upstream (validation, pricing) and downstream (confirmation page,
 * admin inbox) already works off the persisted order.
 */
export async function createOrder(input: CheckoutInput) {
  const settings = await getSettings();

  if (!settings.isPublished) {
    throw new OrderError("This store is not accepting online orders yet.");
  }
  if (!settings.isAcceptingOrders) {
    throw new OrderError(
      "Online ordering is temporarily paused. Please call the store.",
    );
  }
  if (input.orderType === "pickup" && !settings.pickupEnabled) {
    throw new OrderError("Pickup is not available right now.");
  }
  if (input.orderType === "delivery" && !settings.deliveryEnabled) {
    throw new OrderError("Delivery is not available right now.");
  }

  const cart = await priceCart(input.lines, input.orderType);

  if (
    input.orderType === "delivery" &&
    cart.subtotalCents < settings.deliveryMinimumCents
  ) {
    throw new OrderError(
      `Delivery orders have a minimum subtotal of $${(
        settings.deliveryMinimumCents / 100
      ).toFixed(2)}.`,
    );
  }

  const [order] = await db
    .insert(orders)
    .values({
      orderType: input.orderType,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      customerEmail: input.customerEmail || null,
      addressLine1: input.addressLine1 || null,
      addressLine2: input.addressLine2 || null,
      city: input.city || null,
      zip: input.zip || null,
      orderNotes: input.orderNotes || null,
      subtotalCents: cart.subtotalCents,
      taxCents: cart.taxCents,
      deliveryFeeCents: cart.deliveryFeeCents,
      tipCents: input.tipCents,
      totalCents: cart.totalCents + input.tipCents,
      paymentStatus: "pending",
    })
    .returning();

  await db.insert(orderItems).values(
    cart.lines.map((l) => ({
      orderId: order.id,
      menuItemId: l.itemId,
      itemName: l.itemName,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      lineTotalCents: l.lineTotalCents,
      modifiers: l.modifiers,
      notes: l.notes || null,
    })),
  );

  return order;
}
