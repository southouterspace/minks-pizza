import { eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  categories,
  db,
  itemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
  orderDiscounts,
  orderEvents,
  orderItems,
  orders,
  promotions,
  storeSettings,
  type OrderItemModifier,
} from "@/db";
import type { KitchenStation } from "@/lib/kds";
import type { AppliedDiscount } from "@/lib/promotion-engine";
import type { CheckoutInput } from "@/lib/validation";

export type PricedLine = {
  itemId: number;
  categoryId: number;
  /** Chosen modifier ids, so promotions can target a size. */
  modifierIds: number[];
  itemName: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  modifiers: OrderItemModifier[];
  notes?: string;
  station: KitchenStation;
};

export type PricedCart = {
  lines: PricedLine[];
  subtotalCents: number;
  deliveryFeeCents: number;
};

export class OrderError extends Error {}

export type StoreSettings = typeof storeSettings.$inferSelect;

export async function getSettings(): Promise<StoreSettings> {
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
  settings: StoreSettings,
): Promise<PricedCart> {
  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const items = await db
    .select({ item: menuItems, station: categories.station })
    .from(menuItems)
    .innerJoin(categories, eq(categories.id, menuItems.categoryId))
    .where(inArray(menuItems.id, itemIds));
  const itemById = new Map(
    items.map(({ item, station }) => [item.id, { ...item, station }]),
  );

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
      categoryId: item.categoryId,
      modifierIds: line.modifierIds,
      itemName: item.name,
      quantity: line.quantity,
      unitPriceCents: unitPrice,
      lineTotalCents: unitPrice * line.quantity,
      modifiers: chosen,
      notes: line.notes,
      station: item.station,
    };
  });

  const subtotalCents = priced.reduce((sum, l) => sum + l.lineTotalCents, 0);
  const deliveryFeeCents =
    orderType === "delivery" ? settings.deliveryFeeCents : 0;

  return { lines: priced, subtotalCents, deliveryFeeCents };
}

/** Everything an order row and its children are written from. */
export type NewOrder = {
  input: CheckoutInput;
  customerKey: string;
  prepMinutes: number;
  lines: PricedLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  /** Including the tip. */
  totalCents: number;
  discounts: AppliedDiscount[];
};

/**
 * Inserts the order, its lines, its "placed" event and its redemptions as
 * one statement that writes nothing unless `guard` holds, after locking the
 * promotions it redeems. Returns null when the guard failed (a deal's limit
 * went to another order after the quote). Drizzle's builders can't express
 * a data-modifying CTE, hence the SQL template, as in order-writes.ts.
 */
export async function insertOrder(o: NewOrder, guard: SQL): Promise<typeof orders.$inferSelect | null> {
  const { input } = o;
  const placedAt = new Date();
  const at = placedAt.toISOString();
  const promisedAt = new Date(placedAt.getTime() + o.prepMinutes * 60_000).toISOString();
  const lines = o.lines.map((l) => ({
    menu_item_id: l.itemId,
    item_name: l.itemName,
    quantity: l.quantity,
    unit_price_cents: l.unitPriceCents,
    line_total_cents: l.lineTotalCents,
    modifiers: l.modifiers,
    notes: l.notes || null,
    station: l.station,
  }));
  const discounts = o.discounts.map((a) => ({
    promotion_id: a.promotionId,
    code_id: a.codeId,
    label: a.label,
    amount_cents: a.amountCents,
    target: a.target,
    customer_key: o.customerKey,
  }));

  const orderId = crypto.randomUUID();
  const place = db.execute(sql`
    with placed as (
      insert into ${orders} (id, placed_at, promised_at, order_type, customer_name, customer_phone, customer_email,
        address_line1, address_line2, city, zip, order_notes, subtotal_cents, discount_cents, tax_cents,
        delivery_fee_cents, tip_cents, total_cents, payment_status)
      select ${orderId}::uuid, ${at}::timestamptz, ${promisedAt}::timestamptz, ${input.orderType}::order_type,
        ${input.customerName}::text, ${input.customerPhone}::text, ${input.customerEmail || null}::text,
        ${input.addressLine1 || null}::text, ${input.addressLine2 || null}::text, ${input.city || null}::text,
        ${input.zip || null}::text, ${input.orderNotes || null}::text, ${o.subtotalCents}::integer,
        ${o.discountCents}::integer, ${o.taxCents}::integer, ${o.deliveryFeeCents}::integer,
        ${input.tipCents}::integer, ${o.totalCents}::integer, 'pending'
      where ${guard}
      returning id
    ), placed_event as (
      insert into ${orderEvents} (order_id, type, to_status, actor, created_at)
      select id, 'placed', 'new', 'Customer', ${at}::timestamptz from placed
    ), placed_lines as (
      insert into ${orderItems} (order_id, menu_item_id, item_name, quantity, unit_price_cents, line_total_cents, modifiers, notes, station)
      select placed.id, x.menu_item_id, x.item_name, x.quantity, x.unit_price_cents, x.line_total_cents, x.modifiers, x.notes, x.station
      from placed, jsonb_to_recordset(${JSON.stringify(lines)}::jsonb) as x(menu_item_id integer, item_name text,
        quantity integer, unit_price_cents integer, line_total_cents integer, modifiers jsonb, notes text, station kitchen_station)
    ), placed_discounts as (
      insert into ${orderDiscounts} (order_id, promotion_id, code_id, label, amount_cents, target, customer_key, source)
      select placed.id, x.promotion_id, x.code_id, x.label, x.amount_cents, x.target, x.customer_key, 'promotion'
      from placed, jsonb_to_recordset(${JSON.stringify(discounts)}::jsonb) as x(promotion_id integer, code_id integer,
        label text, amount_cents integer, target discount_target, customer_key text)
    )
    select id from placed`);

  // Read back in the same transaction; no row means the guard failed.
  const read = db.select().from(orders).where(eq(orders.id, orderId));

  const promotionIds = [...new Set(o.discounts.map((a) => a.promotionId))].sort((a, b) => a - b);
  if (promotionIds.length === 0) {
    const [, [order]] = await db.batch([place, read]);
    return order ?? null;
  }
  // Locks in id order so two checkouts can't deadlock; one racing for the
  // same promotion waits here until the first commits, then its guard
  // (a later statement, so a fresh snapshot) counts the winner's order.
  const [, , [order]] = await db.batch([
    db.execute(sql`select id from ${promotions} where id in ${promotionIds} order by id for update`),
    place,
    read,
  ]);
  return order ?? null;
}
