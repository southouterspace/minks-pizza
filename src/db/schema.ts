import {
  boolean,
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
import { KITCHEN_STATIONS } from "../lib/kds";
import { GROUP_ROLES, HALF_TOPPING_RULES, type LineModifier } from "../lib/pricing";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Kitchen lifecycle, derived from line stamps by the status fold in
 * orders-server.ts. `held` = nothing fired yet (scheduled or a held check).
 */
export const orderStatusEnum = pgEnum("order_status", [
  "held",
  "new",
  "preparing",
  "ready",
  "completed",
  "canceled",
]);

export const orderTypeEnum = pgEnum("order_type", ["pickup", "delivery", "dine_in"]);

export const orderChannelEnum = pgEnum("order_channel", ["online", "walk_in", "phone"]);

export const modifierRoleEnum = pgEnum("modifier_role", GROUP_ROLES);

export const halfToppingRuleEnum = pgEnum("half_topping_rule", HALF_TOPPING_RULES);

export const employeeRoleEnum = pgEnum("employee_role", ["cashier", "manager", "owner"]);

export const tenderDirectionEnum = pgEnum("tender_direction", ["payment", "refund"]);

export const tenderMethodEnum = pgEnum("tender_method", ["cash", "card_external"]);

export const adjustmentKindEnum = pgEnum("adjustment_kind", ["discount", "comp"]);

export const drawerEventKindEnum = pgEnum("drawer_event_kind", ["no_sale", "paid_in", "paid_out"]);

/**
 * Where a category's items are made, for kitchen-display routing. `counter`
 * items (drinks, packaged desserts) need no kitchen work: they show on the
 * ticket for the expo but never hold an order back from "ready".
 */
export const kitchenStationEnum = pgEnum("kitchen_station", KITCHEN_STATIONS);

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
  halfToppingRule: halfToppingRuleEnum("half_topping_rule").notNull().default("average"),
  /** Price of an "extra" portion as a multiple of the topping price (20000 = 2×). */
  extraToppingBps: integer("extra_topping_bps").notNull().default(20_000),
  /** Discounts above this need a manager. */
  discountApprovalCents: integer("discount_approval_cents").notNull().default(500),
  ovenCapacityPies: integer("oven_capacity_pies").notNull().default(6),
  makeMinutes: integer("make_minutes").notNull().default(3),
  /** The POS drops back to the PIN pad after this long. */
  posLockSeconds: integer("pos_lock_seconds").notNull().default(120),
  /** IANA zone: where report days start and end, and how times print. */
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
  /** Drives builder order, half placement, and the KDS layout. */
  role: modifierRoleEnum("role").notNull().default("option"),
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

export const employees = pgTable(
  "employees",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    role: employeeRoleEnum("role").notNull().default("cashier"),
    /** HMAC-SHA256(SESSION_SECRET, pin): a PIN is found with one indexed lookup. */
    pinDigest: text("pin_digest").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("employees_active_pin").on(t.pinDigest).where(sql`is_active`)],
);

/** Failed PIN entries per signed-in device, so 4 digits can't be walked. */
export const pinAttempts = pgTable("pin_attempts", {
  operatorId: integer("operator_id")
    .primaryKey()
    .references(() => operators.id, { onDelete: "cascade" }),
  failures: integer("failures").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
});

export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Digits only (see normalizePhone). */
  phone: text("phone").notNull().unique(),
  name: text("name").notNull(),
  email: text("email"),
  notes: text("notes"),
  lastOrderAt: timestamp("last_order_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customerAddresses = pgTable(
  "customer_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    line1: text("line1").notNull(),
    line2: text("line2"),
    city: text("city"),
    zip: text("zip").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customer_addresses_unique").on(t.customerId, t.line1, t.zip)],
);

export const shifts = pgTable(
  "shifts",
  {
    id: uuid("id").primaryKey(),
    openedBy: integer("opened_by")
      .notNull()
      .references(() => employees.id),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    startingBankCents: integer("starting_bank_cents").notNull(),
    closedBy: integer("closed_by").references(() => employees.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    countedCashCents: integer("counted_cash_cents"),
    cardBatchCents: integer("card_batch_cents"),
    declaredCashTipsCents: integer("declared_cash_tips_cents"),
    notes: text("notes"),
  },
  (t) => [uniqueIndex("shifts_one_open").on(sql`(closed_at is null)`).where(sql`${t.closedAt} is null`)],
);

export const orders = pgTable(
  "orders",
  {
    /** Client-minted at the POS, so a replayed submit lands on the same row. */
    id: uuid("id").primaryKey().defaultRandom(),
    orderNumber: integer("order_number").notNull().generatedAlwaysAsIdentity({
      startWith: 1001,
    }),
    status: orderStatusEnum("status").notNull().default("held"),
    orderType: orderTypeEnum("order_type").notNull(),
    channel: orderChannelEnum("channel").notNull().default("online"),
    tableLabel: text("table_label"),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    customerEmail: text("customer_email"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    zip: text("zip"),
    orderNotes: text("order_notes"),
    /** Null = online. */
    createdBy: integer("created_by").references(() => employees.id),
    /** When a held order fires to the kitchen on its own (see fireDue). */
    fireAt: timestamp("fire_at", { withTimezone: true }),
    promisedAt: timestamp("promised_at", { withTimezone: true }),
    /** Set on a split-by-item check: the KDS keeps it on its parent's ticket. */
    ticketOrderId: uuid("ticket_order_id"),
    // Money folds: written only by recomputeTotals in orders-server.ts.
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    discountCents: integer("discount_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    deliveryFeeCents: integer("delivery_fee_cents").notNull().default(0),
    tipCents: integer("tip_cents").notNull().default(0),
    /**
     * The store rate when the order was placed. The fold taxes with this, so
     * changing the store rate never re-taxes an order paid or edited later.
     * No default: an insert that forgets it should fail, not tax at 0%.
     */
    taxRateBps: integer("tax_rate_bps").notNull(),
    totalCents: integer("total_cents").notNull().default(0),
    paidCents: integer("paid_cents").notNull().default(0),
    refundedCents: integer("refunded_cents").notNull().default(0),
    placedAt: timestamp("placed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set when the kitchen bumps the order (status → ready); cleared on recall. */
    readyAt: timestamp("ready_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("orders_customer").on(t.customerId),
    index("orders_held_fire_at").on(t.fireAt).where(sql`${t.status} = 'held'`),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    /** Client-minted line id the POS addresses lines by; makes line inserts replayable. */
    lineUid: uuid("line_uid").notNull().unique().defaultRandom(),
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
    modifiers: jsonb("modifiers").$type<LineModifier[]>().notNull(),
    notes: text("notes"),
    /**
     * Kitchen station snapshot, copied from the category at order time so
     * re-routing a category never reshuffles tickets already on the line.
     */
    station: kitchenStationEnum("station").notNull().default("kitchen"),
    /** Null = held back from the kitchen. */
    firedAt: timestamp("fired_at", { withTimezone: true }),
    /** Pizza line: set when the pie goes into the oven (make line → oven). */
    ovenAt: timestamp("oven_at", { withTimezone: true }),
    /** Set when the item is finished (pies: out of the oven, cut and boxed). */
    doneAt: timestamp("done_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: integer("voided_by").references(() => employees.id),
    voidReason: text("void_reason"),
    voidApprovedBy: integer("void_approved_by").references(() => employees.id),
  },
  (t) => [index("order_items_order").on(t.orderId)],
);

/** The money ledger. Refunds are rows, never edits. */
export const tenders = pgTable(
  "tenders",
  {
    id: uuid("id").primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    /** Null only for tenders not taken at a till (online payments, later). */
    shiftId: uuid("shift_id").references(() => shifts.id),
    direction: tenderDirectionEnum("direction").notNull(),
    method: tenderMethodEnum("method").notNull(),
    /** Applied to the order. Cash change = tendered - amount. */
    amountCents: integer("amount_cents").notNull(),
    tenderedCents: integer("tendered_cents"),
    tipCents: integer("tip_cents").notNull().default(0),
    last4: text("last4"),
    employeeId: integer("employee_id").references(() => employees.id),
    approvedBy: integer("approved_by").references(() => employees.id),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tenders_order").on(t.orderId), index("tenders_shift").on(t.shiftId)],
);

export const adjustments = pgTable(
  "adjustments",
  {
    id: uuid("id").primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    /** Null = the whole check. */
    lineUid: uuid("line_uid"),
    kind: adjustmentKindEnum("kind").notNull(),
    cents: integer("cents").notNull(),
    reason: text("reason").notNull(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id),
    approvedBy: integer("approved_by").references(() => employees.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("adjustments_order").on(t.orderId)],
);

export const drawerEvents = pgTable("drawer_events", {
  id: uuid("id").primaryKey(),
  shiftId: uuid("shift_id")
    .notNull()
    .references(() => shifts.id),
  kind: drawerEventKindEnum("kind").notNull(),
  cents: integer("cents").notNull().default(0),
  reason: text("reason"),
  employeeId: integer("employee_id")
    .notNull()
    .references(() => employees.id),
  approvedBy: integer("approved_by").references(() => employees.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
  tenders: many(tenders),
  adjustments: many(adjustments),
}));

export const tendersRelations = relations(tenders, ({ one }) => ({
  order: one(orders, { fields: [tenders.orderId], references: [orders.id] }),
}));

export const adjustmentsRelations = relations(adjustments, ({ one }) => ({
  order: one(orders, { fields: [adjustments.orderId], references: [orders.id] }),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
}));
