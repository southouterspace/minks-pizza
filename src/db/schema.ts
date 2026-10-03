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
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { KITCHEN_STATIONS } from "../lib/kds";
import {
  DEFAULT_STAFF_RULES,
  DEFAULT_TIMEZONE,
  JOB_ROLES,
  TIME_AUDIT_ACTIONS,
  type AuditSnapshot,
  type StoredAvailability,
} from "../lib/timeclock";

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
  /** IANA zone. Every staff day and payroll week is computed in it. */
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
  /** HMAC of the clock PIN; null = cannot use the time clock. */
  pinDigest: text("pin_digest").unique(),
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
