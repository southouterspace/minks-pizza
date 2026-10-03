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
  uuid,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { KITCHEN_STATIONS } from "../lib/kds";
import {
  ORDER_EVENT_TYPES,
  ORDER_STATUSES,
  PAYMENT_METHODS,
} from "../lib/order-workflow";
import {
  DISCOUNT_SOURCES,
  DISCOUNT_TARGETS,
  PROMOTION_TRIGGERS,
  type PromotionReward,
  type WeeklyWindow,
} from "../lib/promotions";

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

export const promotionTriggerEnum = pgEnum("promotion_trigger", PROMOTION_TRIGGERS);

export const discountTargetEnum = pgEnum("discount_target", DISCOUNT_TARGETS);

export const discountSourceEnum = pgEnum("discount_source", DISCOUNT_SOURCES);

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending", // awaiting payment integration (Stripe) — v1 default
  "paid",
  "refunded",
]);

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
  groupName: string;
  modifierName: string;
  priceDeltaCents: number;
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
  /** Sum of this order's order_discounts rows; subtotalCents stays the gross item subtotal. */
  discountCents: integer("discount_cents").notNull().default(0),
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

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

export const promotions = pgTable(
  "promotions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    /** Customer-facing headline, e.g. "Tuesday 2-for-1 Larges". */
    name: text("name").notNull(),
    /** Terms shown to customers. */
    description: text("description"),
    trigger: promotionTriggerEnum("trigger").notNull(),
    /** Validated by promotionRewardSchema on every write and parsed on read. */
    reward: jsonb("reward").$type<PromotionReward>().notNull(),
    minSubtotalCents: integer("min_subtotal_cents").notNull().default(0),
    orderTypes: orderTypeEnum("order_types").array().notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    /** Exclusive: the instant the offer stops. */
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** Null = any time; windows are on the store's clock. */
    schedule: jsonb("schedule").$type<WeeklyWindow[]>(),
    newCustomersOnly: boolean("new_customers_only").notNull().default(false),
    perCustomerLimit: integer("per_customer_limit"),
    totalLimit: integer("total_limit"),
    stackable: boolean("stackable").notNull().default(false),
    /** Shown in the storefront deals strip; off = a private code. */
    advertised: boolean("advertised").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("promotions_order_types_check", sql`cardinality(${t.orderTypes}) > 0`)],
);

export const promotionCodes = pgTable(
  "promotion_codes",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    promotionId: integer("promotion_id")
      .notNull()
      .references(() => promotions.id, { onDelete: "cascade" }),
    /** normalizeCode form, the one matching uses. */
    code: text("code").notNull().unique(),
    /** As the operator wrote or generated it: "MINK-7KQ2-X9". */
    display: text("display").notNull(),
    /** 1 for generated single-use codes; null = unlimited. */
    maxUses: integer("max_uses"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("promotion_codes_promotion_id_idx").on(t.promotionId)],
);

/**
 * The redemption ledger: one row per promotion applied to an order, plus
 * operator comps. Usage is derived by counting rows whose order isn't
 * canceled, so a cancel gives the use back with no counter to drift.
 */
export const orderDiscounts = pgTable(
  "order_discounts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    promotionId: integer("promotion_id").references(() => promotions.id, { onDelete: "set null" }),
    codeId: integer("code_id").references(() => promotionCodes.id, { onDelete: "set null" }),
    /** Snapshot of the promotion name or comp reason, shown on the receipt forever. */
    label: text("label").notNull(),
    amountCents: integer("amount_cents").notNull(),
    target: discountTargetEnum("target").notNull(),
    customerKey: text("customer_key").notNull(),
    source: discountSourceEnum("source").notNull(),
    operatorId: integer("operator_id").references(() => operators.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("order_discounts_amount_check", sql`${t.amountCents} > 0`),
    index("order_discounts_order_id_idx").on(t.orderId),
    index("order_discounts_promotion_id_idx").on(t.promotionId),
    index("order_discounts_code_id_idx").on(t.codeId),
    index("order_discounts_customer_key_promotion_id_idx").on(t.customerKey, t.promotionId),
  ],
);

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
  discounts: many(orderDiscounts),
}));

export const orderDiscountsRelations = relations(orderDiscounts, ({ one }) => ({
  order: one(orders, {
    fields: [orderDiscounts.orderId],
    references: [orders.id],
  }),
}));

export const promotionsRelations = relations(promotions, ({ many }) => ({
  codes: many(promotionCodes),
}));

export const promotionCodesRelations = relations(promotionCodes, ({ one }) => ({
  promotion: one(promotions, {
    fields: [promotionCodes.promotionId],
    references: [promotions.id],
  }),
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
