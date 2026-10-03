import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  categories,
  db,
  itemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
  orderEvents,
  orderItems,
  orders,
  storeSettings,
  type OrderItemModifier,
} from "@/db";

type StoreSettings = typeof storeSettings.$inferSelect;
import type { KitchenStation } from "@/lib/kds";
import {
  INSUFFICIENT_POINTS,
  activePromotion,
  applyReward,
  earnPoints,
  normalizePhone,
  tierFor,
  type Redemption,
} from "@/lib/loyalty";
import {
  enrollStatements,
  getLoyaltySettings,
  getReward,
  isInsufficientPoints,
  ledgerKey,
  ledgerStatement,
  listPromotions,
  memberByPhone,
  qualifyingPoints,
  type LoyaltyMember,
  type LoyaltyReward,
} from "@/lib/loyalty-server";
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
  station: KitchenStation;
  categoryId: number;
};

export type PricedCart = {
  lines: PricedLine[];
  subtotalCents: number;
  deliveryFeeCents: number;
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
  settings: Pick<StoreSettings, "deliveryFeeCents">,
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
      itemName: item.name,
      quantity: line.quantity,
      unitPriceCents: unitPrice,
      lineTotalCents: unitPrice * line.quantity,
      modifiers: chosen,
      notes: line.notes,
      station: item.station,
      categoryId: item.categoryId,
    };
  });

  return {
    lines: priced,
    subtotalCents: priced.reduce((sum, l) => sum + l.lineTotalCents, 0),
    deliveryFeeCents: orderType === "delivery" ? settings.deliveryFeeCents : 0,
  };
}

export type OrderQuote = PricedCart & {
  discountCents: number;
  taxCents: number;
  totalCents: number; // before tip
  loyalty: {
    programName: string;
    /** A rejected redemption means the order would be refused. */
    redemption: Redemption<LoyaltyReward>;
    pointsEarned: number;
    promoName: string | null;
  } | null;
};

/**
 * Prices a cart and applies the loyalty program: the reward discount (tax is
 * on the discounted subtotal) and the points this order will earn. `member`
 * earns, and spends when `rewardId` is set.
 */
export async function quoteOrder(
  input: Pick<CheckoutInput, "lines" | "orderType" | "rewardId">,
  member: LoyaltyMember | null,
): Promise<OrderQuote> {
  const rewardId = input.rewardId ?? null;
  const [settings, loyalty, promos, reward, qualifying] = await Promise.all([
    getSettings(),
    getLoyaltySettings(),
    listPromotions(),
    rewardId === null ? null : getReward(rewardId),
    member ? qualifyingPoints(member.id) : 0,
  ]);
  const cart = await priceCart(input.lines, input.orderType, settings);

  const redemption: Redemption<LoyaltyReward> =
    loyalty.enabled && rewardId !== null ? applyReward(reward, member, cart.lines) : { status: "none" };
  const discountCents = redemption.status === "applied" ? redemption.discountCents : 0;
  const netCents = cart.subtotalCents - discountCents;
  const taxCents = taxFromBps(netCents, settings.taxRateBps);
  const base = {
    ...cart,
    discountCents,
    taxCents,
    totalCents: netCents + taxCents + cart.deliveryFeeCents,
  };
  if (!loyalty.enabled) return { ...base, loyalty: null };

  const promo = activePromotion(promos, new Date(), settings.timezone);
  return {
    ...base,
    loyalty: {
      programName: loyalty.programName,
      redemption,
      promoName: promo?.name ?? null,
      pointsEarned: earnPoints({
        netCents,
        pointsPerDollar: loyalty.pointsPerDollar,
        tierMultiplierBps: tierFor(qualifying, loyalty.tiers).multiplierBps,
        promoMultiplierBps: promo?.multiplierBps ?? 10_000,
      }),
    },
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
 *
 * `signedIn` is the member from the session, never from the client; only
 * they can spend points. A guest who opts in earns on their phone number.
 */
export async function createOrder(input: CheckoutInput, signedIn: LoyaltyMember | null = null) {
  const [settings, loyalty] = await Promise.all([getSettings(), getLoyaltySettings()]);

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
  if (loyalty.enabled && input.rewardId != null && !signedIn) {
    throw new OrderError("Sign in to use your points.");
  }

  const phone = normalizePhone(input.customerPhone);
  // A guest opting in is enrolled inside the order's batch, so a rejected
  // order enrolls nobody. Until then a new phone earns like any new member.
  const joiningPhone = loyalty.enabled && !signedIn && input.joinLoyalty && phone ? phone : null;
  const member = signedIn ?? (joiningPhone ? await memberByPhone(joiningPhone) : null);

  const quote = await quoteOrder(input, member);
  const redemption = quote.loyalty?.redemption ?? { status: "none" };
  if (redemption.status === "rejected") throw new OrderError(redemption.error);

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
  // the points it spends go in as one transaction: a failure can't leave an
  // order with no items, and two orders racing for the same points can't
  // both win.
  const orderId = randomUUID();
  const reward = redemption.status === "applied" ? redemption.reward : null;
  try {
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
          totalCents: quote.totalCents + input.tipCents,
          paymentStatus: "pending",
          loyaltyMemberId: quote.loyalty ? (signedIn?.id ?? null) : null,
          loyaltyRewardName: reward?.name ?? null,
          loyaltyPointsRedeemed: reward?.price.cost ?? 0,
          loyaltyPointsEarned: quote.loyalty?.pointsEarned ?? 0,
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
      ...(quote.loyalty && joiningPhone ? enrollStatements(orderId, joiningPhone, input.customerName) : []),
      ...(reward && signedIn
        ? [
            ledgerStatement({
              kind: "redeem",
              idemKey: ledgerKey.redeem(orderId),
              orderId,
              note: reward.name,
              from: { memberId: signedIn.id, points: -reward.price.cost },
            }),
          ]
        : []),
    ]);
    return order;
  } catch (err) {
    if (isInsufficientPoints(err)) throw new OrderError(INSUFFICIENT_POINTS);
    throw err;
  }
}
