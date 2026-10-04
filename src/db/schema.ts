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
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { COUNT_KINDS, INVENTORY_MOVE_KINDS, WASTE_REASONS } from "../lib/inventory-domain";
import {
  COURIER_PROVIDERS,
  COURIER_STATUSES,
  ORDER_SOURCES,
  TERMINAL_COURIER_STATUSES,
} from "../lib/delivery/types";
import { KITCHEN_STATIONS } from "../lib/kds";
import { GROUP_ROLES, HALF_TOPPING_RULES, type LineModifier } from "../lib/pricing";
import { POS_ACCESS_LEVELS } from "../lib/pos-access";
import { BASE_UNITS } from "../lib/units";
import { DEFAULT_TIMEZONE } from "../lib/zoned";
import {
  DEFAULT_TIERS,
  LEDGER_KINDS,
  type LoyaltyTier,
  type RewardEffect,
} from "../lib/loyalty";
import {
  DEFAULT_STAFF_RULES,
  JOB_ROLES,
  TIME_AUDIT_ACTIONS,
  type AuditSnapshot,
  type StoredAvailability,
} from "../lib/timeclock";
import { ORDER_EVENT_TYPES, ORDER_STATUSES } from "../lib/order-workflow";
import { TENDER_METHODS } from "../lib/orders";
import {
  DISCOUNT_SOURCES,
  DISCOUNT_TARGETS,
  PROMOTION_TRIGGERS,
  type PromotionReward,
  type WeeklyWindow,
} from "../lib/promotion-schema";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Kitchen lifecycle, derived from line stamps by the status fold in
 * orders-server/folds.ts. `held` = nothing fired yet (scheduled or a held check).
 */
export const orderStatusEnum = pgEnum("order_status", ORDER_STATUSES);

export const orderTypeEnum = pgEnum("order_type", ["pickup", "delivery", "dine_in"]);

export const modifierRoleEnum = pgEnum("modifier_role", GROUP_ROLES);

export const halfToppingRuleEnum = pgEnum("half_topping_rule", HALF_TOPPING_RULES);

/** What an employee may do at the POS terminal; a permission, not a job. */
export const posAccessEnum = pgEnum("pos_access", POS_ACCESS_LEVELS);

export const tenderDirectionEnum = pgEnum("tender_direction", ["payment", "refund"]);

export const tenderMethodEnum = pgEnum("tender_method", TENDER_METHODS);

export const drawerEventKindEnum = pgEnum("drawer_event_kind", ["no_sale", "paid_in", "paid_out"]);

/**
 * Where a category's items are made, for kitchen-display routing. `counter`
 * items (drinks, packaged desserts) need no kitchen work: they show on the
 * ticket for the expo but never hold an order back from "ready".
 */
export const kitchenStationEnum = pgEnum("kitchen_station", KITCHEN_STATIONS);

export const orderEventTypeEnum = pgEnum("order_event_type", ORDER_EVENT_TYPES);

export const promotionTriggerEnum = pgEnum("promotion_trigger", PROMOTION_TRIGGERS);

export const discountTargetEnum = pgEnum("discount_target", DISCOUNT_TARGETS);

export const discountSourceEnum = pgEnum("discount_source", DISCOUNT_SOURCES);

export const baseUnitEnum = pgEnum("base_unit", BASE_UNITS);
export const inventoryMoveKindEnum = pgEnum("inventory_move_kind", INVENTORY_MOVE_KINDS);
export const wasteReasonEnum = pgEnum("waste_reason", WASTE_REASONS);
export const countKindEnum = pgEnum("count_kind", COUNT_KINDS);
/** Where an order was placed: our storefront, the counter, or a delivery marketplace. */
export const orderSourceEnum = pgEnum("order_source", ORDER_SOURCES);

export const courierProviderEnum = pgEnum("courier_provider", COURIER_PROVIDERS);

export const courierStatusEnum = pgEnum("courier_status", COURIER_STATUSES);

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
  /** Price of a half-pie topping as a share of its whole-pie price (5000 = half), under the average rule. */
  halfToppingPriceBps: integer("half_topping_price_bps").notNull().default(5000),
  /** Price of an "extra" portion as a multiple of the topping price (20000 = 2×), unless the modifier names its own. */
  extraToppingBps: integer("extra_topping_bps").notNull().default(20_000),
  /** Recipe usage of a half-pie, light and extra portion as a share of a regular whole-pie one. */
  halfPortionBps: integer("half_portion_bps").notNull().default(5000),
  lightPortionBps: integer("light_portion_bps").notNull().default(5000),
  extraPortionBps: integer("extra_portion_bps").notNull().default(15000),
  /** Margin report flags items below this share of price. */
  minMarginBps: integer("min_margin_bps").notNull().default(7000),
  /** Discounts above this need a manager. */
  discountApprovalCents: integer("discount_approval_cents").notNull().default(500),
  ovenCapacityPies: integer("oven_capacity_pies").notNull().default(6),
  makeMinutes: integer("make_minutes").notNull().default(3),
  /** The POS drops back to the PIN pad after this long. */
  posLockSeconds: integer("pos_lock_seconds").notNull().default(120),
  /** IANA zone: where report days start and end, and how times print. */
  timezone: text("timezone").notNull().default(DEFAULT_TIMEZONE),
  /** Payroll week start: 0 = Sunday … 6 = Saturday. */
  weekStartsOn: integer("week_starts_on").notNull().default(DEFAULT_STAFF_RULES.weekStartsOn),
  otWeeklyMinutes: integer("ot_weekly_minutes").notNull().default(DEFAULT_STAFF_RULES.otWeeklyMinutes),
  /** Daily overtime threshold (California: 480); null = off. */
  otDailyMinutes: integer("ot_daily_minutes"),
  /** Daily double-time threshold (California: 720); null = off. */
  dtDailyMinutes: integer("dt_daily_minutes"),
  /** Flags a punch with no unpaid break past this many paid minutes; never deducts. Null = off. */
  breakRequiredAfterMinutes: integer("break_required_after_minutes").default(DEFAULT_STAFF_RULES.breakRequiredAfterMinutes),
  /** Late / early-out tolerance against the schedule. */
  clockGraceMinutes: integer("clock_grace_minutes").notNull().default(DEFAULT_STAFF_RULES.clockGraceMinutes),
  /** The kiosk refuses a clock-in more than this many minutes before today's shift; null = off. */
  earlyClockInMinutes: integer("early_clock_in_minutes"),
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
  /** What this item comes with from the group (a pie's toppings and sauce); empty keeps the group's defaults. */
  defaultModifierIds: integer("default_modifier_ids").array().notNull().default([]),
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/** Failed PIN entries per signed-in device, so a short PIN can't be walked. */
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

/** A cash drawer session: opened with a bank, closed with a count. Only one is open at a time. */
export const drawerSessions = pgTable(
  "drawer_sessions",
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
  (t) => [uniqueIndex("drawer_sessions_one_open").on(sql`(closed_at is null)`).where(sql`${t.closedAt} is null`)],
);

export const orders = pgTable(
  "orders",
  {
    /** Client-minted at the POS, so a replayed submit lands on the same row. */
    id: uuid("id").primaryKey().defaultRandom(),
    orderNumber: integer("order_number").notNull().generatedAlwaysAsIdentity({
      startWith: 1001,
    }),
    source: orderSourceEnum("source").notNull().default("web"),
    /** The marketplace's own order id; null for our own orders. */
    sourceOrderId: text("source_order_id"),
    /** The short code a marketplace driver reads out at the counter. */
    sourceDisplayId: text("source_display_id"),
    status: orderStatusEnum("status").notNull().default("held"),
    orderType: orderTypeEnum("order_type").notNull(),
    tableLabel: text("table_label"),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    /**
     * The phone's last ten digits, who promotion limits count against. Generated
     * so every order has one, including orders placed before the column existed;
     * customerKeyFromPhone is the same rule for quotes made before an order exists.
     */
    customerKey: text("customer_key").generatedAlwaysAs(
      sql`right(regexp_replace(customer_phone, '\\D', '', 'g'), 10)`,
    ),
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
    // Money folds: written only by recomputeTotals in orders-server/folds.ts
    // (marketplace orders keep the totals the platform sent).
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    /** Sum of this order's live order_discounts rows; subtotalCents stays the gross item subtotal. */
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
    completedAt: timestamp("completed_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    loyaltyMemberId: integer("loyalty_member_id").references(
      (): AnyPgColumn => loyaltyMembers.id,
      { onDelete: "set null" },
    ),
    loyaltyRewardName: text("loyalty_reward_name"),
    loyaltyPointsRedeemed: integer("loyalty_points_redeemed").notNull().default(0),
    /** Promised at checkout, posted to the ledger when the order completes. */
    loyaltyPointsEarned: integer("loyalty_points_earned").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("orders_customer").on(t.customerId),
    index("orders_held_fire_at").on(t.fireAt).where(sql`${t.status} = 'held'`),
    index("orders_customer_key_idx").on(t.customerKey),
    // Makes marketplace ingestion idempotent. Our own orders have a null
    // source_order_id, and nulls never collide.
    uniqueIndex("orders_source_order_idx").on(t.source, t.sourceOrderId),
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
    /** Food cost at the recipe's unit costs, stamped while the order is completed. */
    costCents: integer("cost_cents"),
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
    /** Null for tenders not taken at a till: an admin recording a payment, a marketplace's collection. */
    drawerSessionId: uuid("drawer_session_id").references(() => drawerSessions.id),
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
  (t) => [index("tenders_order").on(t.orderId), index("tenders_drawer_session").on(t.drawerSessionId)],
);

export const drawerEvents = pgTable("drawer_events", {
  id: uuid("id").primaryKey(),
  drawerSessionId: uuid("drawer_session_id")
    .notNull()
    .references(() => drawerSessions.id),
  kind: drawerEventKindEnum("kind").notNull(),
  cents: integer("cents").notNull().default(0),
  reason: text("reason"),
  employeeId: integer("employee_id")
    .notNull()
    .references(() => employees.id),
  approvedBy: integer("approved_by").references(() => employees.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
    /** Display name at the time: operator or employee name, "Customer", "Scheduler", or "Kitchen display · <name>". */
    actor: text("actor").notNull(),
    operatorId: integer("operator_id").references(() => operators.id, {
      onDelete: "set null",
    }),
    employeeId: integer("employee_id").references(() => employees.id, { onDelete: "set null" }),
    /** The manager whose PIN approved a gated POS action. */
    approvedBy: integer("approved_by").references(() => employees.id, { onDelete: "set null" }),
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
 * staff comps and discounts. Usage is derived by counting rows whose order
 * isn't canceled, so a cancel gives the use back with no counter to drift.
 */
export const orderDiscounts = pgTable(
  "order_discounts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    /** Client-minted at the POS, so a replayed discount lands on the same row. Null for promotion and loyalty rows. */
    uid: uuid("uid").unique(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** A comp on one line (the line's whole total); null = the check. */
    lineUid: uuid("line_uid"),
    promotionId: integer("promotion_id").references(() => promotions.id, { onDelete: "set null" }),
    codeId: integer("code_id").references(() => promotionCodes.id, { onDelete: "set null" }),
    /** Snapshot of the promotion name or comp reason, shown on the receipt forever. */
    label: text("label").notNull(),
    amountCents: integer("amount_cents").notNull(),
    target: discountTargetEnum("target").notNull(),
    source: discountSourceEnum("source").notNull(),
    operatorId: integer("operator_id").references(() => operators.id, { onDelete: "set null" }),
    employeeId: integer("employee_id").references(() => employees.id, { onDelete: "set null" }),
    approvedBy: integer("approved_by").references(() => employees.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("order_discounts_amount_check", sql`${t.amountCents} > 0`),
    index("order_discounts_order_id_idx").on(t.orderId),
    index("order_discounts_promotion_id_idx").on(t.promotionId),
    index("order_discounts_code_id_idx").on(t.codeId),
  ],
);

// ---------------------------------------------------------------------------
// Staff: employees, schedule, time clock
//
// Employees are not operators: they never sign in to the admin. They identify
// at the shared time clock with a PIN.
// ---------------------------------------------------------------------------

export const jobRoleEnum = pgEnum("job_role", JOB_ROLES);

export const staffSourceEnum = pgEnum("staff_source", ["kiosk", "manager"]);

export const timeAuditActionEnum = pgEnum("time_audit_action", TIME_AUDIT_ACTIONS);

export const timeOffStatusEnum = pgEnum("time_off_status", ["pending", "approved", "denied"]);

export const employees = pgTable("employees", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  /** HMAC of the PIN for the time clock and the POS; null = neither. */
  pinDigest: text("pin_digest").unique(),
  /** Who may unlock the POS terminal and who may approve there. */
  posAccess: posAccessEnum("pos_access").notNull().default("none"),
  /** Archived employees leave the schedule and the clock; payroll history keeps them. */
  isActive: boolean("is_active").notNull().default(true),
  /** Null = available any time. */
  availability: jsonb("availability").$type<StoredAvailability>(),
  notes: text("notes"),
  hiredOn: date("hired_on"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const employeeRoles = pgTable(
  "employee_roles",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    role: jobRoleEnum("role").notNull(),
    hourlyRateCents: integer("hourly_rate_cents").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => [unique("employee_roles_employee_role").on(t.employeeId, t.role)],
);

/** The schedule. A null employee is an open shift. */
export const shifts = pgTable(
  "shifts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    employeeId: integer("employee_id").references(() => employees.id, { onDelete: "set null" }),
    role: jobRoleEnum("role").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    unpaidBreakMinutes: integer("unpaid_break_minutes").notNull().default(0),
    notes: text("notes"),
    /** Null = draft. Staff never see drafts. */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("shifts_ends_after_starts", sql`${t.endsAt} > ${t.startsAt}`),
    index("shifts_starts_at").on(t.startsAt),
  ],
);

/** One clocked shift (a punch). */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    shiftId: integer("shift_id").references(() => shifts.id, { onDelete: "set null" }),
    role: jobRoleEnum("role").notNull(),
    /** Rate snapshot at clock-in, so a raise never rewrites past pay. */
    hourlyRateCents: integer("hourly_rate_cents").notNull(),
    clockInAt: timestamp("clock_in_at", { withTimezone: true }).notNull(),
    clockOutAt: timestamp("clock_out_at", { withTimezone: true }),
    declaredTipsCents: integer("declared_tips_cents").notNull().default(0),
    note: text("note"),
    source: staffSourceEnum("source").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: integer("approved_by").references(() => operators.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The database, not the app, guarantees one open punch per person:
    // a double tap or a second tablet loses the race here.
    uniqueIndex("time_entries_one_open").on(t.employeeId).where(sql`${t.clockOutAt} is null`),
    check("time_entries_out_after_in", sql`${t.clockOutAt} is null or ${t.clockOutAt} > ${t.clockInAt}`),
    index("time_entries_clock_in_at").on(t.clockInAt),
  ],
);

export const timeBreaks = pgTable(
  "time_breaks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    timeEntryId: integer("time_entry_id")
      .notNull()
      .references(() => timeEntries.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    paid: boolean("paid").notNull().default(false),
  },
  (t) => [
    uniqueIndex("time_breaks_one_open").on(t.timeEntryId).where(sql`${t.endedAt} is null`),
    check("time_breaks_end_after_start", sql`${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt}`),
  ],
);

/** Every manager change to time, with its reason. Survives the entry's deletion. */
export const timeEntryAudit = pgTable("time_entry_audit", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  timeEntryId: integer("time_entry_id").references(() => timeEntries.id, { onDelete: "set null" }),
  employeeId: integer("employee_id")
    .notNull()
    .references(() => employees.id, { onDelete: "cascade" }),
  operatorId: integer("operator_id").references(() => operators.id, { onDelete: "set null" }),
  action: timeAuditActionEnum("action").notNull(),
  reason: text("reason"),
  before: jsonb("before").$type<AuditSnapshot>(),
  after: jsonb("after").$type<AuditSnapshot>(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const timeOffRequests = pgTable(
  "time_off_requests",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** Store-local dates, both inclusive. */
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    reason: text("reason"),
    status: timeOffStatusEnum("status").notNull().default("pending"),
    source: staffSourceEnum("source").notNull(),
    decidedBy: integer("decided_by").references(() => operators.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("time_off_end_after_start", sql`${t.endDate} >= ${t.startDate}`),
    // One live request per person and date range: a retried kiosk request
    // or a double tap lands on the existing row instead of a second one.
    uniqueIndex("time_off_one_live").on(t.employeeId, t.startDate, t.endDate).where(sql`${t.status} <> 'denied'`),
  ],
);

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
    /** The entry this one undoes (a restore names its expiry); at most once. */
    reversesEntryId: integer("reverses_entry_id")
      .unique()
      .references((): AnyPgColumn => loyaltyLedger.id, { onDelete: "cascade" }),
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
// Delivery integrations
// ---------------------------------------------------------------------------

const TERMINAL_SQL = sql.raw(TERMINAL_COURIER_STATUSES.map((s) => `'${s}'`).join(", "));

/** A courier we dispatched (Uber Direct, DoorDash Drive) for a web order. */
export const courierDeliveries = pgTable(
  "courier_deliveries",
  {
    /** Sent as DoorDash `external_delivery_id` and Uber `external_id`. */
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    provider: courierProviderEnum("provider").notNull(),
    /** Uber's `del_…` id; for DoorDash, the same as our id. */
    providerDeliveryId: text("provider_delivery_id"),
    status: courierStatusEnum("status").notNull().default("requested"),
    feeCents: integer("fee_cents"),
    currency: text("currency"),
    trackingUrl: text("tracking_url"),
    courierName: text("courier_name"),
    courierPhone: text("courier_phone"),
    pickupEta: timestamp("pickup_eta", { withTimezone: true }),
    dropoffEta: timestamp("dropoff_eta", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // An order can never have two live couriers.
    uniqueIndex("courier_deliveries_live_order_idx")
      .on(t.orderId)
      .where(sql`status not in (${TERMINAL_SQL})`),
    uniqueIndex("courier_deliveries_provider_idx").on(t.provider, t.providerDeliveryId),
  ],
);

/**
 * Webhook inbox. Every accepted delivery is recorded before it is applied;
 * the unique key turns provider retries into no-ops.
 */
export const integrationEvents = pgTable(
  "integration_events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    source: text("source").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [uniqueIndex("integration_events_dedupe_idx").on(t.source, t.dedupeKey)],
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
  tenders: many(tenders),
  events: many(orderEvents),
  discounts: many(orderDiscounts),
  courierDeliveries: many(courierDeliveries),
}));

export const tendersRelations = relations(tenders, ({ one }) => ({
  order: one(orders, { fields: [tenders.orderId], references: [orders.id] }),
}));

export const courierDeliveriesRelations = relations(courierDeliveries, ({ one }) => ({
  order: one(orders, {
    fields: [courierDeliveries.orderId],
    references: [orders.id],
  }),
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

export const employeesRelations = relations(employees, ({ many }) => ({
  roles: many(employeeRoles),
  shifts: many(shifts),
  timeEntries: many(timeEntries),
  timeOff: many(timeOffRequests),
}));

export const employeeRolesRelations = relations(employeeRoles, ({ one }) => ({
  employee: one(employees, { fields: [employeeRoles.employeeId], references: [employees.id] }),
}));

export const shiftsRelations = relations(shifts, ({ one }) => ({
  employee: one(employees, { fields: [shifts.employeeId], references: [employees.id] }),
}));

export const timeEntriesRelations = relations(timeEntries, ({ one, many }) => ({
  employee: one(employees, { fields: [timeEntries.employeeId], references: [employees.id] }),
  shift: one(shifts, { fields: [timeEntries.shiftId], references: [shifts.id] }),
  breaks: many(timeBreaks),
  audit: many(timeEntryAudit),
}));

export const timeBreaksRelations = relations(timeBreaks, ({ one }) => ({
  entry: one(timeEntries, { fields: [timeBreaks.timeEntryId], references: [timeEntries.id] }),
}));

export const timeEntryAuditRelations = relations(timeEntryAudit, ({ one }) => ({
  entry: one(timeEntries, { fields: [timeEntryAudit.timeEntryId], references: [timeEntries.id] }),
  operator: one(operators, { fields: [timeEntryAudit.operatorId], references: [operators.id] }),
}));

export const timeOffRequestsRelations = relations(timeOffRequests, ({ one }) => ({
  employee: one(employees, { fields: [timeOffRequests.employeeId], references: [employees.id] }),
}));
