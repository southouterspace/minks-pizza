import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { KITCHEN_STATIONS } from "../lib/kds";
import {
  DEFAULT_TIERS,
  LEDGER_KINDS,
  type LoyaltyTier,
  type RewardEffect,
} from "../lib/loyalty";

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

/**
 * Where a category's items are made, for kitchen-display routing. `counter`
 * items (drinks, packaged desserts) need no kitchen work: they show on the
 * ticket for the expo but never hold an order back from "ready".
 */
export const kitchenStationEnum = pgEnum("kitchen_station", KITCHEN_STATIONS);

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
  totalCents: integer("total_cents").notNull(),
  paymentStatus: paymentStatusEnum("payment_status")
    .notNull()
    .default("pending"),
  placedAt: timestamp("placed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Set when the kitchen bumps the order (status → ready); cleared on recall. */
  readyAt: timestamp("ready_at", { withTimezone: true }),
  loyaltyMemberId: integer("loyalty_member_id").references(
    (): AnyPgColumn => loyaltyMembers.id,
    { onDelete: "set null" },
  ),
  discountCents: integer("discount_cents").notNull().default(0),
  loyaltyRewardName: text("loyalty_reward_name"),
  loyaltyPointsRedeemed: integer("loyalty_points_redeemed").notNull().default(0),
  /** Promised at checkout, posted to the ledger when the order completes. */
  loyaltyPointsEarned: integer("loyalty_points_earned").notNull().default(0),
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

// ---------------------------------------------------------------------------
// Loyalty
// ---------------------------------------------------------------------------

export const loyaltyEntryKindEnum = pgEnum("loyalty_entry_kind", LEDGER_KINDS);

export const loyaltySettings = pgTable("loyalty_settings", {
  id: integer("id").primaryKey(), // always 1
  enabled: boolean("enabled").notNull().default(false),
  programName: text("program_name").notNull().default("Mink's Rewards"),
  pointsPerDollar: integer("points_per_dollar").notNull().default(10),
  signupBonus: integer("signup_bonus").notNull().default(200),
  birthdayPoints: integer("birthday_points").notNull().default(700),
  referrerBonus: integer("referrer_bonus").notNull().default(500),
  refereeBonus: integer("referee_bonus").notNull().default(300),
  /** Months of inactivity before the balance expires; null = never. */
  expirationMonths: integer("expiration_months").default(12),
  timezone: text("timezone").notNull().default("America/Chicago"),
  tiers: jsonb("tiers").$type<LoyaltyTier[]>().notNull().default(DEFAULT_TIERS),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const loyaltyRewards = pgTable("loyalty_rewards", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  description: text("description"),
  pointsCost: integer("points_cost").notNull(),
  /** While protected, customers pay min(points_cost, previous_points_cost). */
  previousPointsCost: integer("previous_points_cost"),
  priceProtectedUntil: timestamp("price_protected_until", { withTimezone: true }),
  effect: jsonb("effect").$type<RewardEffect>().notNull(),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const loyaltyPromotions = pgTable("loyalty_promotions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  multiplierBps: integer("multiplier_bps").notNull(), // 20000 = 2x
  /** 0 = Sunday; empty = every day. */
  daysOfWeek: jsonb("days_of_week").$type<number[]>().notNull().default([]),
  /** Inclusive, in the store's timezone. */
  startsOn: date("starts_on"),
  endsOn: date("ends_on"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const loyaltyMembers = pgTable(
  "loyalty_members",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    phone: text("phone").notNull().unique(), // 10 digits
    name: text("name"),
    email: text("email"),
    birthMonth: integer("birth_month"),
    birthDay: integer("birth_day"),
    birthdaySetAt: timestamp("birthday_set_at", { withTimezone: true }),
    referralCode: text("referral_code").notNull().unique(),
    referredById: integer("referred_by_id").references(
      (): AnyPgColumn => loyaltyMembers.id,
      { onDelete: "set null" },
    ),
    /** Cache of SUM(loyalty_ledger.points); only the ledger statement writes it. */
    pointsBalance: integer("points_balance").notNull().default(0),
    lifetimePoints: integer("lifetime_points").notNull().default(0),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** Last completed order, or enrollment; points expire on inactivity. */
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [check("points_balance_non_negative", sql`${t.pointsBalance} >= 0`)],
);

export const loyaltyLedger = pgTable(
  "loyalty_ledger",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    memberId: integer("member_id")
      .notNull()
      .references(() => loyaltyMembers.id, { onDelete: "cascade" }),
    kind: loyaltyEntryKindEnum("kind").notNull(),
    points: integer("points").notNull(),
    orderId: uuid("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    idemKey: text("idem_key").notNull().unique(),
    note: text("note"),
    operatorId: integer("operator_id").references(() => operators.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("points_non_zero", sql`${t.points} <> 0`),
    index("loyalty_ledger_member_created_idx").on(t.memberId, t.createdAt),
  ],
);

export const loyaltyLoginCodes = pgTable(
  "loyalty_login_codes",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    phone: text("phone").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("loyalty_login_codes_phone_idx").on(t.phone)],
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
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
}));
