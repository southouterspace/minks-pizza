import { eq, getTableColumns, inArray, sql, type Column, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
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
import type { AppliedDiscount } from "@/lib/promotion-engine";
import type { RedemptionCheck } from "@/lib/promotion-usage";
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
 * `insert into t (cols) select cols from jsonb_populate_recordset(null::t, rows) where cond`.
 * Postgres types each value by the table's own row type, so the rows need no
 * casts and TypeScript checks them against the schema. Only the columns some
 * row sets are written; the rest take their defaults or generated values.
 */
function insertRowsWhere<T extends PgTable>(table: T, rows: T["$inferInsert"][], cond: SQL): SQL {
  const columns: Record<string, Column> = getTableColumns(table);
  const keys = Object.keys(columns).filter((k) => rows.some((r) => r[k as keyof typeof r] !== undefined));
  const names = sql.join(keys.map((k) => sql.identifier(columns[k].name)), sql`, `);
  const json = rows.map((r) => Object.fromEntries(keys.map((k) => [columns[k].name, r[k as keyof typeof r] ?? null])));
  return sql`insert into ${table} (${names})
    select ${names} from jsonb_populate_recordset(null::${table}, ${JSON.stringify(json)}::jsonb) where ${cond}`;
}

/**
 * Inserts the order, its lines, its "placed" event and its redemptions as
 * one statement that writes nothing unless the redemption guard holds, after
 * the lock that lets the guard see any order that won a race.
 * Returns null when the guard failed (a deal's limit went to another order
 * after the quote). Drizzle's builders can't make an insert conditional on
 * another table, hence the SQL template.
 */
export async function insertOrder(o: NewOrder, check: RedemptionCheck): Promise<typeof orders.$inferSelect | null> {
  const { input } = o;
  const orderId = crypto.randomUUID();
  const placedAt = new Date();
  const placed = sql`exists (select 1 from placed)`;
  const children = [
    insertRowsWhere(orderEvents, [{ orderId, type: "placed", toStatus: "new", actor: "Customer", createdAt: placedAt }], placed),
    insertRowsWhere(
      orderItems,
      o.lines.map((l) => ({
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
      placed,
    ),
    ...(o.discounts.length
      ? [
          insertRowsWhere(
            orderDiscounts,
            o.discounts.map((a) => ({
              orderId,
              promotionId: a.promotionId,
              codeId: a.codeId,
              label: a.label,
              amountCents: a.amountCents,
              target: a.target,
              customerKey: o.customerKey,
              source: "promotion" as const,
            })),
            placed,
          ),
        ]
      : []),
  ];
  const order = insertRowsWhere(
    orders,
    [
      {
        id: orderId,
        placedAt,
        promisedAt: new Date(placedAt.getTime() + o.prepMinutes * 60_000),
        orderType: input.orderType,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        customerEmail: input.customerEmail || null,
        addressLine1: input.addressLine1 || null,
        addressLine2: input.addressLine2 || null,
        city: input.city || null,
        zip: input.zip || null,
        orderNotes: input.orderNotes || null,
        subtotalCents: o.subtotalCents,
        discountCents: o.discountCents,
        taxCents: o.taxCents,
        deliveryFeeCents: o.deliveryFeeCents,
        tipCents: input.tipCents,
        totalCents: o.totalCents,
      },
    ],
    check.guard,
  );
  const place = db.execute(sql`
    with placed as (${order} returning id),
    ${sql.join(children.map((c, i) => sql`${sql.identifier(`child${i}`)} as (${c})`), sql`, `)}
    select id from placed`);
  // Read back in the same transaction; no row means the guard failed.
  const read = db.select().from(orders).where(eq(orders.id, orderId));
  const [, , [row]] = await db.batch([db.execute(check.lock), place, read]);
  return row ?? null;
}
