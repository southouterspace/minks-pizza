import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { COUNT_KINDS, INVENTORY_MOVE_KINDS, WASTE_REASONS } from "../lib/inventory-domain";
import { KITCHEN_STATIONS } from "../lib/kds";
import { MODIFIER_GROUP_KINDS, type Placement, type Portion } from "../lib/toppings";
import { BASE_UNITS } from "../lib/units";
import {
  ORDER_EVENT_TYPES,
  ORDER_STATUSES,
  PAYMENT_METHODS,
} from "../lib/order-workflow";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const orderStatusEnum = pgEnum("order_status", ORDER_STATUSES);

export const orderTypeEnum = pgEnum("order_type", ["pickup", "delivery"]);

/**
 * Where a category's items are made, for kitchen-display routing. `counter`
 * items (drinks, packaged desserts) need no kitchen work: they show on the
 * ticket for the expo but never hold an order back from "ready".
 */
export const kitchenStationEnum = pgEnum("kitchen_station", KITCHEN_STATIONS);

/** How an operator says the order was paid at the counter or door. */
export const paymentMethodEnum = pgEnum("payment_method", PAYMENT_METHODS);

export const orderEventTypeEnum = pgEnum("order_event_type", ORDER_EVENT_TYPES);

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending", // awaiting payment integration (Stripe) — v1 default
  "paid",
  "refunded",
]);

export const modifierGroupKindEnum = pgEnum("modifier_group_kind", MODIFIER_GROUP_KINDS);
export const baseUnitEnum = pgEnum("base_unit", BASE_UNITS);
export const inventoryMoveKindEnum = pgEnum("inventory_move_kind", INVENTORY_MOVE_KINDS);
export const wasteReasonEnum = pgEnum("waste_reason", WASTE_REASONS);
export const countKindEnum = pgEnum("count_kind", COUNT_KINDS);

// ---------------------------------------------------------------------------
// Operator accounts
// ---------------------------------------------------------------------------

export const operators = pgTable("operators", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Store settings (singleton row, id = 1)
// ---------------------------------------------------------------------------

export type DayHours = {
  /** 0 = Sunday … 6 = Saturday */
  day: number;
  open: string; // "11:00"
  close: string; // "21:30"
  closed: boolean;
};

export const storeSettings = pgTable("store_settings", {
  id: integer("id").primaryKey(), // always 1
  name: text("name").notNull().default("My Pizzeria"),
  tagline: text("tagline"),
  /** Externally hosted logo (https URL). Ignored when an upload exists. */
  logoUrl: text("logo_url"),
  /**
   * Set when an uploaded logo lives in `store_logo`. Kept here (rather than
   * joining) so the storefront can build the asset URL — and cache-bust it —
   * without ever pulling the image bytes into a page query.
   */
  logoUploadedAt: timestamp("logo_uploaded_at", { withTimezone: true }),
  phone: text("phone"),
  email: text("email"),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  hours: jsonb("hours").$type<DayHours[]>(),
  pickupEnabled: boolean("pickup_enabled").notNull().default(true),
  deliveryEnabled: boolean("delivery_enabled").notNull().default(false),
  pickupPrepMinutes: integer("pickup_prep_minutes").notNull().default(20),
  deliveryPrepMinutes: integer("delivery_prep_minutes").notNull().default(45),
  deliveryFeeCents: integer("delivery_fee_cents").notNull().default(0),
  deliveryMinimumCents: integer("delivery_minimum_cents").notNull().default(0),
  taxRateBps: integer("tax_rate_bps").notNull().default(0), // e.g. 875 = 8.75%
  /** Kitchen display: ticket timer turns amber at this age (minutes). */
  kdsWarnMinutes: integer("kds_warn_minutes").notNull().default(10),
  /** Kitchen display: ticket timer turns red at this age (minutes). */
  kdsLateMinutes: integer("kds_late_minutes").notNull().default(15),
  /** Kitchen display: oven bake countdown for a pie (minutes). */
  kdsOvenMinutes: integer("kds_oven_minutes").notNull().default(7),
  /** IANA zone that defines the store's day for stats, history and times. */
  timezone: text("timezone").notNull().default("America/Chicago"),
  halfToppingPriceBps: integer("half_topping_price_bps").notNull().default(5000),
  halfPortionBps: integer("half_portion_bps").notNull().default(5000),
  lightPortionBps: integer("light_portion_bps").notNull().default(5000),
  extraPortionBps: integer("extra_portion_bps").notNull().default(15000),
  minMarginBps: integer("min_margin_bps").notNull().default(7000),
  isPublished: boolean("is_published").notNull().default(false),
  isAcceptingOrders: boolean("is_accepting_orders").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The uploaded store logo, in its own table so the image bytes are never
 * dragged into the `store_settings` reads that happen on every page render.
 * Base64 rather than bytea to keep the serverless HTTP driver on plain text.
 */
export const storeLogo = pgTable("store_logo", {
  id: integer("id").primaryKey(), // always 1
  contentType: text("content_type").notNull(),
  data: text("data").notNull(), // base64
  byteSize: integer("byte_size").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

export const categories = pgTable("categories", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  description: text("description"),
  station: kitchenStationEnum("station").notNull().default("kitchen"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const menuItems = pgTable("menu_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  categoryId: integer("category_id")
    .notNull()
    .references(() => categories.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  basePriceCents: integer("base_price_cents").notNull().default(0),
  imageUrl: text("image_url"),
  isAvailable: boolean("is_available").notNull().default(true), // false = 86'd
  isFeatured: boolean("is_featured").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const modifierGroups = pgTable("modifier_groups", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(), // "Size", "Crust", "Toppings"
  kind: modifierGroupKindEnum("kind").notNull().default("choice"),
  /** Minimum selections required (0 = optional group). */
  minSelect: integer("min_select").notNull().default(0),
  /** Maximum selections allowed (null = unlimited). 1 ⇒ radio, else checkboxes. */
  maxSelect: integer("max_select"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const modifiers = pgTable("modifiers", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  groupId: integer("group_id")
    .notNull()
    .references(() => modifierGroups.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  priceDeltaCents: integer("price_delta_cents").notNull().default(0),
  extraPriceDeltaCents: integer("extra_price_delta_cents"),
  isDefault: boolean("is_default").notNull().default(false),
  isAvailable: boolean("is_available").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

/** Junction: which modifier groups apply to which items, in what order. */
export const itemModifierGroups = pgTable("item_modifier_groups", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  itemId: integer("item_id")
    .notNull()
    .references(() => menuItems.id, { onDelete: "cascade" }),
  groupId: integer("group_id")
    .notNull()
    .references(() => modifierGroups.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/** Snapshot of one chosen modifier, denormalized into the order line. */
export type OrderItemModifier = {
  modifierId?: number;
  groupName: string;
  modifierName: string;
  priceDeltaCents: number;
  placement?: Placement;
  portion?: Portion;
};

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderNumber: integer("order_number").notNull().generatedAlwaysAsIdentity({
    startWith: 1001,
  }),
  status: orderStatusEnum("status").notNull().default("new"),
  orderType: orderTypeEnum("order_type").notNull(),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone").notNull(),
  customerEmail: text("customer_email"),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  zip: text("zip"),
  orderNotes: text("order_notes"),
  subtotalCents: integer("subtotal_cents").notNull(),
  taxCents: integer("tax_cents").notNull(),
  deliveryFeeCents: integer("delivery_fee_cents").notNull().default(0),
  tipCents: integer("tip_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull(),
  paymentStatus: paymentStatusEnum("payment_status")
    .notNull()
    .default("pending"),
  paymentMethod: paymentMethodEnum("payment_method"),
  /**
   * The ready time quoted to the customer: placedAt + prep minutes at
   * checkout, pushed later by operators. Null on orders from before it existed.
   */
  promisedAt: timestamp("promised_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason"),
  placedAt: timestamp("placed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Set when the kitchen bumps the order (status → ready); cleared on recall. */
  readyAt: timestamp("ready_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const orderItems = pgTable("order_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  menuItemId: integer("menu_item_id").references(() => menuItems.id, {
    onDelete: "set null",
  }),
  itemName: text("item_name").notNull(),
  quantity: integer("quantity").notNull().default(1),
  /** Per-unit price including modifier deltas, at time of order. */
  unitPriceCents: integer("unit_price_cents").notNull(),
  lineTotalCents: integer("line_total_cents").notNull(),
  modifiers: jsonb("modifiers").$type<OrderItemModifier[]>().notNull(),
  notes: text("notes"),
  costCents: integer("cost_cents"),
  /**
   * Kitchen station snapshot, copied from the category at order time so
   * re-routing a category never reshuffles tickets already on the line.
   */
  station: kitchenStationEnum("station").notNull().default("kitchen"),
  /** Pizza line: set when the pie goes into the oven (make line → oven). */
  ovenAt: timestamp("oven_at", { withTimezone: true }),
  /** Set when the item is finished (pies: out of the oven, cut and boxed). */
  doneAt: timestamp("done_at", { withTimezone: true }),
});

/** Append-only audit trail: one row per thing that happened to an order. */
export const orderEvents = pgTable(
  "order_events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    type: orderEventTypeEnum("type").notNull(),
    fromStatus: orderStatusEnum("from_status"),
    toStatus: orderStatusEnum("to_status"),
    /** Display name at the time: operator name, "Customer", or "Kitchen display · <name>". */
    actor: text("actor").notNull(),
    operatorId: integer("operator_id").references(() => operators.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("order_events_order_id_created_at_idx").on(t.orderId, t.createdAt)],
);

export const ingredients = pgTable("ingredients", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  baseUnit: baseUnitEnum("base_unit").notNull(),
  unitCostMillicents: integer("unit_cost_millicents").notNull().default(0),
  storageArea: text("storage_area").notNull().default("Walk-in"),
  shelfOrder: integer("shelf_order").notNull().default(0),
  lowStockAtMilli: integer("low_stock_at_milli"),
  outAtMilli: integer("out_at_milli"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const ingredientPacks = pgTable("ingredient_packs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  ingredientId: integer("ingredient_id")
    .notNull()
    .references(() => ingredients.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  baseQtyMilli: integer("base_qty_milli").notNull(),
});

export const recipeLines = pgTable(
  "recipe_lines",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    menuItemId: integer("menu_item_id").references(() => menuItems.id, { onDelete: "cascade" }),
    modifierId: integer("modifier_id").references(() => modifiers.id, { onDelete: "cascade" }),
    sizeModifierId: integer("size_modifier_id").references(() => modifiers.id, {
      onDelete: "cascade",
    }),
    ingredientId: integer("ingredient_id")
      .notNull()
      .references(() => ingredients.id, { onDelete: "restrict" }),
    qtyMilli: integer("qty_milli").notNull(),
  },
  (t) => [
    check("recipe_lines_one_owner", sql`num_nonnulls(${t.menuItemId}, ${t.modifierId}) = 1`),
    // Not UNIQUE NULLS NOT DISTINCT: drizzle-kit 0.31 can't read that back, so
    // every push offered to truncate recipe_lines to re-add it. It can't
    // compare expressions either, so it rebuilds this index on each push,
    // which is harmless.
    uniqueIndex("recipe_lines_owner_size_ingredient").on(
      sql`coalesce(${t.menuItemId}, 0)`,
      sql`coalesce(${t.modifierId}, 0)`,
      sql`coalesce(${t.sizeModifierId}, 0)`,
      t.ingredientId,
    ),
  ],
);

export const inventoryCounts = pgTable("inventory_counts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  kind: countKindEnum("kind").notNull(),
  operatorId: integer("operator_id").references(() => operators.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Append-only ledger: on hand is the sum of qty_milli. Rows are never updated or deleted. */
export const inventoryMoves = pgTable(
  "inventory_moves",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    ingredientId: integer("ingredient_id")
      .notNull()
      .references(() => ingredients.id, { onDelete: "restrict" }),
    kind: inventoryMoveKindEnum("kind").notNull(),
    qtyMilli: integer("qty_milli").notNull(),
    unitCostMillicents: integer("unit_cost_millicents").notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    countId: integer("count_id").references(() => inventoryCounts.id, { onDelete: "cascade" }),
    wasteReason: wasteReasonEnum("waste_reason"),
    vendor: text("vendor"),
    operatorId: integer("operator_id").references(() => operators.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("inventory_moves_ingredient_id_id_idx").on(t.ingredientId, t.id),
    index("inventory_moves_order_id_idx").on(t.orderId),
  ],
);

/**
 * One row per ingredient the system auto-86'd, remembering what it turned
 * off so restocking turns exactly that back on. An operator re-enabling an
 * item leaves the row, so later sales don't 86 it again.
 */
export const stockOuts = pgTable("stock_outs", {
  ingredientId: integer("ingredient_id")
    .primaryKey()
    .references(() => ingredients.id, { onDelete: "cascade" }),
  menuItemIds: integer("menu_item_ids").array().notNull(),
  modifierIds: integer("modifier_ids").array().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const categoriesRelations = relations(categories, ({ many }) => ({
  items: many(menuItems),
}));

export const menuItemsRelations = relations(menuItems, ({ one, many }) => ({
  category: one(categories, {
    fields: [menuItems.categoryId],
    references: [categories.id],
  }),
  modifierGroups: many(itemModifierGroups),
}));

export const modifierGroupsRelations = relations(
  modifierGroups,
  ({ many }) => ({
    modifiers: many(modifiers),
    items: many(itemModifierGroups),
  }),
);

export const modifiersRelations = relations(modifiers, ({ one }) => ({
  group: one(modifierGroups, {
    fields: [modifiers.groupId],
    references: [modifierGroups.id],
  }),
}));

export const itemModifierGroupsRelations = relations(
  itemModifierGroups,
  ({ one }) => ({
    item: one(menuItems, {
      fields: [itemModifierGroups.itemId],
      references: [menuItems.id],
    }),
    group: one(modifierGroups, {
      fields: [itemModifierGroups.groupId],
      references: [modifierGroups.id],
    }),
  }),
);

export const ordersRelations = relations(orders, ({ many }) => ({
  items: many(orderItems),
  events: many(orderEvents),
}));

export const orderEventsRelations = relations(orderEvents, ({ one }) => ({
  order: one(orders, {
    fields: [orderEvents.orderId],
    references: [orders.id],
  }),
  operator: one(operators, {
    fields: [orderEvents.operatorId],
    references: [operators.id],
  }),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
}));
