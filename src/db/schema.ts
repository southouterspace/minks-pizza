import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const orderStatusEnum = pgEnum("order_status", [
  "new",
  "confirmed",
  "preparing",
  "ready",
  "completed",
  "canceled",
]);

export const orderTypeEnum = pgEnum("order_type", ["pickup", "delivery"]);

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
  isPublished: boolean("is_published").notNull().default(false),
  isAcceptingOrders: boolean("is_accepting_orders").notNull().default(true),
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
  totalCents: integer("total_cents").notNull(),
  paymentStatus: paymentStatusEnum("payment_status")
    .notNull()
    .default("pending"),
  placedAt: timestamp("placed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
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
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
}));
