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
  storeSettings,
  type OrderItemModifier,
} from "@/db";
import type { KitchenStation } from "@/lib/kds";
import { formatCents, taxFromBps } from "@/lib/money";
import { loadCandidates, phoneKeySql } from "@/lib/promotion-queries";
import {
  customerKeyFromPhone,
  discountedTotals,
  evaluatePromotions,
  normalizeCode,
  REASONS,
  type AppliedDiscount,
  type Evaluation,
  type PromotionCandidate,
} from "@/lib/promotions";
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
  /** The candidates the evaluation used, for the redemption guard. */
  candidates: PromotionCandidate[];
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
    names: loaded.names,
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
    candidates: loaded.candidates,
    customerKey,
  };
}

const LIMIT_SENTINEL = "promotion_limit_reached";

/**
 * Still true for every applied promotion once its row is locked: live, under
 * its total, per-customer and per-code limits, and (for new-customer offers)
 * no other order on this phone. Runs as its own statement after the lock so
 * it reads a snapshot that includes any order that just won the race.
 */
function redemptionGuard(quote: CheckoutQuote, orderId: string): SQL | null {
  const conditions: SQL[] = [];
  const uses = (where: SQL) =>
    sql`(select count(*) from ${orderDiscounts} d join ${orders} o on o.id = d.order_id
         where ${where} and o.status <> 'canceled' and o.id <> ${orderId})`;
  for (const a of quote.applied) {
    const c = quote.candidates.find((x) => x.promotion.id === a.promotionId)!;
    const p = c.promotion;
    conditions.push(sql`exists (select 1 from promotions where id = ${p.id} and is_active and archived_at is null)`);
    if (p.totalLimit !== null) conditions.push(sql`${uses(sql`d.promotion_id = ${p.id}`)} < ${p.totalLimit}`);
    if (p.perCustomerLimit !== null) {
      conditions.push(sql`${uses(sql`d.promotion_id = ${p.id} and d.customer_key = ${quote.customerKey}`)} < ${p.perCustomerLimit}`);
    }
    if (c.code?.maxUses != null) conditions.push(sql`${uses(sql`d.code_id = ${c.code.id}`)} < ${c.code.maxUses}`);
    if (p.newCustomersOnly) {
      conditions.push(
        sql`not exists (select 1 from ${orders} where ${orders.status} <> 'canceled' and ${orders.id} <> ${orderId} and ${phoneKeySql} = ${quote.customerKey})`,
      );
    }
  }
  return conditions.length ? sql.join(conditions, sql` and `) : null;
}

function isLimitRace(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if (e instanceof Error && e.message.includes(LIMIT_SENTINEL)) return true;
  }
  return false;
}

/** "PIZZA10 was just fully redeemed", from why the fresh quote turned the deal down. */
function lostDealMessage(lost: AppliedDiscount, fresh: CheckoutQuote): string {
  if (!lost.code) return `"${lost.label}" just ran out`;
  const code = normalizeCode(lost.code);
  const reason = fresh.rejected.find((r) => r.code === code)?.reason;
  if (reason === REASONS.perCustomer) return `${lost.code} was already used with this phone number`;
  if (reason === REASONS.newCustomers) return `${lost.code} is for new customers only`;
  if (reason === REASONS.soldOut) return `${lost.code} was just fully redeemed`;
  return `${lost.code} is no longer available`;
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

  for (let attempt = 0; ; attempt++) {
    const quote = await quoteCheckout(input);
    const totalCents = quote.totalBeforeTipCents + input.tipCents;
    if (input.expectedTotalCents !== undefined && input.expectedTotalCents !== totalCents) {
      const rejected = quote.rejected[0];
      const typed = rejected && (input.promoCodes ?? []).find((c) => normalizeCode(c) === rejected.code);
      const why = rejected ? `${(typed ?? rejected.code).toUpperCase()}: ${rejected.reason.replace(/\.$/, "")}. ` : "";
      throw new OrderError(`${why}Your total is now ${formatCents(totalCents)}. Check it and place your order again.`);
    }
    try {
      return await insertOrder(input, settings, quote);
    } catch (err) {
      if (!isLimitRace(err)) throw err;
      const fresh = await quoteCheckout(input);
      const lost = quote.applied.find((a) => !fresh.applied.some((f) => f.promotionId === a.promotionId));
      if (!lost && attempt === 0) continue;
      throw new OrderError(
        `${lost ? lostDealMessage(lost, fresh) : "A deal on your order just changed"} — your total is now ${formatCents(fresh.totalBeforeTipCents + input.tipCents)}.`,
      );
    }
  }
}

async function insertOrder(
  input: CheckoutInput,
  settings: Awaited<ReturnType<typeof getSettings>>,
  quote: CheckoutQuote,
) {
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

  // The id is minted here so the order, its lines, its "placed" event and
  // its redemptions go in as one transaction.
  const orderId = crypto.randomUUID();
  const guard = redemptionGuard(quote, orderId);
  const promotionIds = [...new Set(quote.applied.map((a) => a.promotionId))].sort((a, b) => a - b);
  const [[order]] = await db.batch([
    db
      .insert(orders)
      .values({
        id: orderId,
        placedAt,
        promisedAt: new Date(placedAt.getTime() + prepMinutes * 60_000),
        orderType: input.orderType,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        customerEmail: input.customerEmail || null,
        addressLine1: input.addressLine1 || null,
        addressLine2: input.addressLine2 || null,
        city: input.city || null,
        zip: input.zip || null,
        orderNotes: input.orderNotes || null,
        subtotalCents: quote.subtotalCents,
        discountCents: quote.discountCents,
        taxCents: quote.taxCents,
        deliveryFeeCents: quote.deliveryFeeCents,
        tipCents: input.tipCents,
        totalCents: quote.totalBeforeTipCents + input.tipCents,
        paymentStatus: "pending",
      })
      .returning(),
    db.insert(orderEvents).values({
      orderId,
      type: "placed",
      toStatus: "new",
      actor: "Customer",
      createdAt: placedAt,
    }),
    db.insert(orderItems).values(
      quote.lines.map((l) => ({
        orderId,
        menuItemId: l.itemId,
        itemName: l.itemName,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        lineTotalCents: l.lineTotalCents,
        modifiers: l.modifiers,
        notes: l.notes || null,
        station: l.station,
      })),
    ),
    ...(quote.applied.length
      ? [
          // Locks in id order so two checkouts can't deadlock; a checkout
          // racing for the same promotion waits here until the first commits.
          db.execute(sql`select id from promotions where id in ${promotionIds} order by id for update`),
          ...(guard
            ? [db.execute(sql`select (case when ${guard} then '1' else ${LIMIT_SENTINEL} end)::int as ok`)]
            : []),
          db.insert(orderDiscounts).values(
            quote.applied.map((a) => ({
              orderId,
              promotionId: a.promotionId,
              codeId: a.codeId,
              label: a.label,
              amountCents: a.amountCents,
              target: a.target,
              customerKey: quote.customerKey!,
              source: "promotion" as const,
            })),
          ),
        ]
      : []),
  ]);

  return order;
}
