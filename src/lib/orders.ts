import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  categories,
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
import type { KitchenStation } from "@/lib/kds";
import { earnPoints, normalizePhone, rewardDiscount, tierFor } from "@/lib/loyalty";
import {
  INSUFFICIENT_POINTS,
  currentPromotion,
  findOrCreateMember,
  getLoyaltySettings,
  getMember,
  getReward,
  isInsufficientPoints,
  ledgerKey,
  ledgerStatement,
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
    reward: LoyaltyReward | null;
    /** Why the chosen reward can't apply; the order would be rejected. */
    rewardError: string | null;
    pointsEarned: number;
    promoName: string | null;
  } | null;
};

/**
 * Prices a cart and applies the loyalty program: the reward discount (tax is
 * on the discounted subtotal) and the points this order will earn.
 * `member` earns; only a `canRedeem` member (signed in) may spend.
 */
export async function quoteOrder(
  input: Pick<CheckoutInput, "lines" | "orderType">,
  { member, rewardId, canRedeem }: {
    member: LoyaltyMember | null;
    rewardId: number | null;
    canRedeem: boolean;
  },
): Promise<OrderQuote> {
  const [settings, loyalty, cart] = await Promise.all([
    getSettings(),
    getLoyaltySettings(),
    priceCart(input.lines, input.orderType),
  ]);

  let reward: LoyaltyReward | null = null;
  let rewardError: string | null = null;
  let discountCents = 0;
  if (loyalty.enabled && rewardId !== null) {
    reward = await getReward(rewardId);
    const applied = reward ? rewardDiscount(reward.effect, cart.lines) : null;
    if (!reward || !reward.isActive) {
      rewardError = "That reward is no longer available.";
    } else if (!member || !canRedeem) {
      rewardError = "Sign in to use your points.";
    } else if (member.pointsBalance < reward.price.cost) {
      rewardError = INSUFFICIENT_POINTS;
    } else if (!applied?.ok) {
      rewardError = `Add a qualifying item to use "${reward.name}".`;
    } else {
      discountCents = applied.discountCents;
    }
    if (rewardError) reward = null;
  }

  const netCents = cart.subtotalCents - discountCents;
  const taxCents = taxFromBps(netCents, settings.taxRateBps);
  const base = {
    ...cart,
    discountCents,
    taxCents,
    totalCents: netCents + taxCents + cart.deliveryFeeCents,
  };
  if (!loyalty.enabled) return { ...base, loyalty: null };

  const [qualifying, promo] = await Promise.all([
    member ? qualifyingPoints(member.id) : 0,
    currentPromotion(loyalty),
  ]);
  return {
    ...base,
    loyalty: {
      programName: loyalty.programName,
      reward,
      rewardError,
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
 * `ctx.memberId` is the signed-in loyalty member (from the session, never
 * from the client); only they can spend points. A guest who opts in earns
 * on their phone number. The order, its items and the points spent commit
 * in one transaction, so two orders racing for the same points can't both win.
 */
export async function createOrder(
  input: CheckoutInput,
  ctx: { memberId?: number | null } = {},
) {
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

  const signedIn = ctx.memberId != null ? await getMember(ctx.memberId) : null;
  const phone = normalizePhone(input.customerPhone);
  const member =
    signedIn ??
    (input.joinLoyalty && phone && (await getLoyaltySettings()).enabled
      ? (await findOrCreateMember(phone, { name: input.customerName })).member
      : null);

  const quote = await quoteOrder(input, {
    member,
    rewardId: input.rewardId ?? null,
    canRedeem: signedIn !== null,
  });
  if (quote.loyalty?.rewardError) throw new OrderError(quote.loyalty.rewardError);

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

  const orderId = randomUUID();
  const reward = quote.loyalty?.reward ?? null;
  const orderMember = quote.loyalty ? member : null;
  try {
    const [[order]] = await db.batch([
      db
        .insert(orders)
        .values({
          id: orderId,
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
          loyaltyMemberId: orderMember?.id ?? null,
          loyaltyRewardName: reward?.name ?? null,
          loyaltyPointsRedeemed: reward?.price.cost ?? 0,
          loyaltyPointsEarned: quote.loyalty?.pointsEarned ?? 0,
        })
        .returning(),
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
      ...(reward && orderMember
        ? [
            ledgerStatement({
              kind: "redeem",
              idemKey: ledgerKey.redeem(orderId),
              orderId,
              note: reward.name,
              from: { memberId: orderMember.id, points: -reward.price.cost },
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
