import { eq, inArray, sql } from "drizzle-orm";
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
import { formatCents, taxFromBps } from "@/lib/money";
import { loadCandidates } from "@/lib/promotion-queries";
import { redemptionGuard } from "@/lib/promotion-usage";
import { lostDealCopy, refusalCopy } from "@/lib/promotion-copy";
import { normalizeCode } from "@/lib/promo-code";
import type { TargetNames } from "@/lib/promotion-copy";
import {
  customerKeyFromPhone,
  discountedTotals,
  evaluatePromotions,
  type AppliedDiscount,
  type Evaluation,
} from "@/lib/promotion-engine";
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
  const taxCents = taxFromBps(subtotalCents, settings.taxRateBps);

  return {
    lines: priced,
    subtotalCents,
    taxCents,
    deliveryFeeCents,
    totalCents: subtotalCents + taxCents + deliveryFeeCents,
  };
}

export type CheckoutQuote = Evaluation & {
  lines: PricedLine[];
  subtotalCents: number;
  deliveryFeeCents: number;
  taxCents: number;
  /** Everything but the tip, which the customer picks. */
  totalBeforeTipCents: number;
  timezone: string;
  /** For the words of a refusal. */
  names: TargetNames;
  customerKey: string | null;
};

/**
 * The one pricing path: the live preview in cart and checkout and the order
 * insert both come through here, so what the customer sees is what is charged.
 */
export async function quoteCheckout(
  input: {
    lines: CheckoutInput["lines"];
    orderType: "pickup" | "delivery";
    customerPhone?: string;
    promoCodes?: string[];
  },
  now = new Date(),
): Promise<CheckoutQuote> {
  const customerKey = customerKeyFromPhone(input.customerPhone);
  const [settings, cart, loaded] = await Promise.all([
    getSettings(),
    priceCart(input.lines, input.orderType),
    loadCandidates(input.promoCodes ?? [], customerKey),
  ]);
  const evaluation = evaluatePromotions({
    lines: cart.lines,
    orderType: input.orderType,
    subtotalCents: cart.subtotalCents,
    deliveryFeeCents: cart.deliveryFeeCents,
    now,
    timezone: settings.timezone,
    customerKey,
    customerHasOrdered: loaded.customerHasOrdered,
    enteredCodes: loaded.enteredCodes,
    candidates: loaded.candidates,
  });
  const totals = discountedTotals({
    subtotalCents: cart.subtotalCents,
    deliveryFeeCents: cart.deliveryFeeCents,
    tipCents: 0,
    taxRateBps: settings.taxRateBps,
    discounts: evaluation.applied,
  });
  return {
    ...evaluation,
    lines: cart.lines,
    subtotalCents: cart.subtotalCents,
    deliveryFeeCents: cart.deliveryFeeCents,
    taxCents: totals.taxCents,
    totalBeforeTipCents: totals.totalCents,
    timezone: settings.timezone,
    names: loaded.names,
    customerKey,
  };
}

function lostDealMessage(lost: AppliedDiscount, fresh: CheckoutQuote): string {
  const code = lost.code && normalizeCode(lost.code);
  return lostDealCopy(lost, fresh.rejected.find((r) => r.code === code)?.refusal);
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

  let quote = await quoteCheckout(input);
  for (let attempt = 0; ; attempt++) {
    const totalCents = quote.totalBeforeTipCents + input.tipCents;
    if (input.expectedTotalCents !== undefined && input.expectedTotalCents !== totalCents) {
      const rejected = quote.rejected[0];
      const typed = rejected && (input.promoCodes ?? []).find((c) => normalizeCode(c) === rejected.code);
      const why = rejected
        ? `${(typed ?? rejected.code).toUpperCase()}: ${refusalCopy(rejected.refusal, { display: rejected.display, timezone: quote.timezone, names: quote.names })}. `
        : "";
      throw new OrderError(`${why}Your total is now ${formatCents(totalCents)}. Check it and place your order again.`);
    }
    const order = await insertOrder(input, settings, quote);
    if (order) return order;
    // Lost a limit race: say which deal went, from why a fresh quote refuses it.
    const fresh = await quoteCheckout(input);
    const lost = quote.applied.find((a) => !fresh.applied.some((f) => f.promotionId === a.promotionId));
    if (lost || attempt > 0) {
      throw new OrderError(
        `${lost ? lostDealMessage(lost, fresh) : "A deal on your order just changed"} — your total is now ${formatCents(fresh.totalBeforeTipCents + input.tipCents)}.`,
      );
    }
    quote = fresh;
  }
}

/**
 * Inserts the order, its lines, its "placed" event and its redemptions as
 * one statement that writes nothing unless the redemption guard still
 * holds. Returns null when it didn't: a deal's limit went to another order
 * after the quote. Drizzle's builders can't express a data-modifying CTE,
 * hence the SQL template (the same pattern as order-writes.ts).
 */
async function insertOrder(
  input: CheckoutInput,
  settings: Awaited<ReturnType<typeof getSettings>>,
  quote: CheckoutQuote,
): Promise<typeof orders.$inferSelect | null> {
  if (
    input.orderType === "delivery" &&
    quote.subtotalCents < settings.deliveryMinimumCents
  ) {
    throw new OrderError(
      `Delivery orders have a minimum subtotal of $${(
        settings.deliveryMinimumCents / 100
      ).toFixed(2)}.`,
    );
  }

  const placedAt = new Date();
  const prepMinutes =
    input.orderType === "delivery" ? settings.deliveryPrepMinutes : settings.pickupPrepMinutes;
  const at = placedAt.toISOString();
  const promisedAt = new Date(placedAt.getTime() + prepMinutes * 60_000).toISOString();
  const lines = quote.lines.map((l) => ({
    menu_item_id: l.itemId,
    item_name: l.itemName,
    quantity: l.quantity,
    unit_price_cents: l.unitPriceCents,
    line_total_cents: l.lineTotalCents,
    modifiers: l.modifiers,
    notes: l.notes || null,
    station: l.station,
  }));
  const discounts = quote.applied.map((a) => ({
    promotion_id: a.promotionId,
    code_id: a.codeId,
    label: a.label,
    amount_cents: a.amountCents,
    target: a.target,
    customer_key: quote.customerKey,
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
        ${input.zip || null}::text, ${input.orderNotes || null}::text, ${quote.subtotalCents}::integer,
        ${quote.discountCents}::integer, ${quote.taxCents}::integer, ${quote.deliveryFeeCents}::integer,
        ${input.tipCents}::integer, ${quote.totalBeforeTipCents + input.tipCents}::integer, 'pending'
      where ${redemptionGuard(quote.applied, quote.customerKey)}
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

  const promotionIds = [...new Set(quote.applied.map((a) => a.promotionId))].sort((a, b) => a - b);
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
