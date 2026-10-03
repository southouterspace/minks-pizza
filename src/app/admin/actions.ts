"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  categories,
  db,
  itemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
  operators,
  orders,
  storeLogo,
  storeSettings,
  type DayHours,
} from "@/db";
import {
  createSession,
  destroySession,
  hashPassword,
  operatorExists,
  requireOperator,
  verifyPassword,
} from "@/lib/auth";
import { KITCHEN_STATIONS, type KitchenStation } from "@/lib/kds";

export type AuthFormState = { error?: string };

// ---------------------------------------------------------------------------
// FormData helpers
// ---------------------------------------------------------------------------

function textField(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function textOrNull(fd: FormData, name: string): string | null {
  const v = textField(fd, name);
  return v === "" ? null : v;
}

function checkbox(fd: FormData, name: string): boolean {
  return fd.get(name) === "on";
}

/** Required positive integer id (from a hidden input). Throws when tampered. */
function idField(fd: FormData, name: string): number {
  const n = Number.parseInt(textField(fd, name), 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}`);
  return n;
}

/** Non-negative integer with a fallback for blank/invalid input. */
function intField(fd: FormData, name: string, fallback: number): number {
  const n = Number.parseInt(textField(fd, name), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(0, n);
}

/** Dollars string ("12.50") → integer cents. Blank = 0. */
function dollarsToCents(fd: FormData, name: string): number {
  const raw = textField(fd, name);
  if (raw === "") return 0;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n) || n < 0) throw new Error(`Invalid ${name}`);
  return Math.round(n * 100);
}

/** Kitchen-display routing for a category; blank or unknown → "kitchen". */
function stationField(fd: FormData): KitchenStation {
  return z.enum(KITCHEN_STATIONS).catch("kitchen").parse(textField(fd, "station"));
}

function directionField(fd: FormData): "up" | "down" {
  return textField(fd, "direction") === "up" ? "up" : "down";
}

function revalidateMenu(): void {
  revalidatePath("/admin/menu");
  revalidatePath("/");
}

function revalidateModifiers(): void {
  revalidatePath("/admin/modifiers");
  revalidatePath("/");
}

// ---------------------------------------------------------------------------
// Auth: first-run setup, login, logout
// ---------------------------------------------------------------------------

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(200);

const operatorSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.email("Enter a valid email").max(200),
  password: passwordSchema,
});

export async function setupOperator(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (await operatorExists()) redirect("/admin/login");

  const parsed = operatorSchema.safeParse({
    name: formData.get("name"),
    email: textField(formData, "email").toLowerCase(),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ?? "Please check the form and retry.",
    };
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const [operator] = await db
    .insert(operators)
    .values({
      name: parsed.data.name,
      email: parsed.data.email,
      passwordHash,
    })
    .returning({ id: operators.id });
  await createSession(operator.id);
  redirect("/admin");
}

export async function loginOperator(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (!(await operatorExists())) redirect("/admin/setup");

  const email = textField(formData, "email").toLowerCase();
  const password = formData.get("password");
  if (!email || typeof password !== "string" || password.length === 0) {
    return { error: "Enter your email and password." };
  }

  const [operator] = await db
    .select()
    .from(operators)
    .where(eq(operators.email, email));
  const valid = operator
    ? await verifyPassword(password, operator.passwordHash)
    : false;
  if (!operator || !valid) {
    return { error: "Invalid email or password." };
  }

  await createSession(operator.id);
  redirect("/admin");
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect("/admin/login");
}

// ---------------------------------------------------------------------------
// Team: operator accounts
//
// Every operator has full admin access — there are no roles. Adding someone
// here hands them the whole dashboard.
// ---------------------------------------------------------------------------

export async function addOperator(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  await requireOperator();

  const parsed = operatorSchema.safeParse({
    name: formData.get("name"),
    // Lowercased to match loginOperator, which looks accounts up that way.
    email: textField(formData, "email").toLowerCase(),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ?? "Please check the form and retry.",
    };
  }

  try {
    await db.insert(operators).values({
      name: parsed.data.name,
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
    });
  } catch {
    // The unique index on email is the only constraint this insert can trip.
    return { error: "That email already has an account." };
  }

  // Outside the try: redirect() signals by throwing, so a catch would eat it.
  revalidatePath("/admin/team");
  redirect("/admin/team?notice=added");
}

/**
 * Removes another operator. Refusing self-removal is what guarantees at least
 * one account always exists — drop to zero and `/admin/setup` unlocks itself,
 * letting anyone on the internet claim the store.
 */
export async function removeOperator(formData: FormData): Promise<void> {
  const current = await requireOperator();
  const id = idField(formData, "operatorId");
  if (id === current.id) redirect("/admin/team?notice=self-remove");

  await db.delete(operators).where(eq(operators.id, id));
  revalidatePath("/admin/team");
  redirect("/admin/team?notice=removed");
}

/**
 * Lets an operator replace the password someone else chose for them at
 * creation time. Requires the current password so a borrowed session can't
 * lock the real owner out.
 */
export async function changeOwnPassword(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const current = await requireOperator();

  const currentPassword = formData.get("currentPassword");
  if (typeof currentPassword !== "string" || currentPassword.length === 0) {
    return { error: "Enter your current password." };
  }
  const parsed = passwordSchema.safeParse(formData.get("newPassword"));
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Check the new password.",
    };
  }

  const [row] = await db
    .select({ passwordHash: operators.passwordHash })
    .from(operators)
    .where(eq(operators.id, current.id));
  if (!row || !(await verifyPassword(currentPassword, row.passwordHash))) {
    return { error: "That's not your current password." };
  }

  await db
    .update(operators)
    .set({ passwordHash: await hashPassword(parsed.data) })
    .where(eq(operators.id, current.id));

  redirect("/admin/team?notice=password");
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

const STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  new: ["confirmed", "canceled"],
  confirmed: ["preparing", "canceled"],
  preparing: ["ready"],
  ready: ["completed"],
  completed: [],
  canceled: [],
};

const orderStatusSchema = z.enum([
  "confirmed",
  "preparing",
  "ready",
  "completed",
  "canceled",
]);

export async function updateOrderStatus(formData: FormData): Promise<void> {
  await requireOperator();
  const orderId = z.uuid().parse(textField(formData, "orderId"));
  const status = orderStatusSchema.parse(textField(formData, "status"));

  const [order] = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order) return;
  if (!STATUS_TRANSITIONS[order.status]?.includes(status)) return;

  await db
    .update(orders)
    .set({
      status,
      updatedAt: new Date(),
      ...(status === "ready" ? { readyAt: new Date() } : {}),
    })
    .where(eq(orders.id, orderId));
  revalidatePath("/admin");
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function createCategory(formData: FormData): Promise<void> {
  await requireOperator();
  const name = textField(formData, "name");
  if (!name) throw new Error("Category name is required");
  const [last] = await db
    .select({ sortOrder: categories.sortOrder })
    .from(categories)
    .orderBy(desc(categories.sortOrder))
    .limit(1);
  await db.insert(categories).values({
    name,
    description: textOrNull(formData, "description"),
    station: stationField(formData),
    sortOrder: (last?.sortOrder ?? -1) + 1,
  });
  revalidateMenu();
}

export async function updateCategory(formData: FormData): Promise<void> {
  await requireOperator();
  const categoryId = idField(formData, "categoryId");
  const name = textField(formData, "name");
  if (!name) throw new Error("Category name is required");
  await db
    .update(categories)
    .set({
      name,
      description: textOrNull(formData, "description"),
      station: stationField(formData),
    })
    .where(eq(categories.id, categoryId));
  revalidateMenu();
}

export async function toggleCategoryActive(formData: FormData): Promise<void> {
  await requireOperator();
  const categoryId = idField(formData, "categoryId");
  const [category] = await db
    .select({ isActive: categories.isActive })
    .from(categories)
    .where(eq(categories.id, categoryId));
  if (!category) return;
  await db
    .update(categories)
    .set({ isActive: !category.isActive })
    .where(eq(categories.id, categoryId));
  revalidateMenu();
}

export async function deleteCategory(formData: FormData): Promise<void> {
  await requireOperator();
  const categoryId = idField(formData, "categoryId");
  await db.delete(categories).where(eq(categories.id, categoryId));
  revalidateMenu();
}

export async function moveCategory(formData: FormData): Promise<void> {
  await requireOperator();
  const categoryId = idField(formData, "categoryId");
  const direction = directionField(formData);

  const list = await db
    .select({ id: categories.id, sortOrder: categories.sortOrder })
    .from(categories)
    .orderBy(asc(categories.sortOrder), asc(categories.id));
  const index = list.findIndex((c) => c.id === categoryId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index === -1 || target < 0 || target >= list.length) return;

  [list[index], list[target]] = [list[target], list[index]];
  for (let i = 0; i < list.length; i++) {
    if (list[i].sortOrder !== i) {
      await db
        .update(categories)
        .set({ sortOrder: i })
        .where(eq(categories.id, list[i].id));
    }
  }
  revalidateMenu();
}

// ---------------------------------------------------------------------------
// Menu items
// ---------------------------------------------------------------------------

export async function toggleItemAvailability(formData: FormData): Promise<void> {
  await requireOperator();
  const itemId = idField(formData, "itemId");
  const [item] = await db
    .select({ isAvailable: menuItems.isAvailable })
    .from(menuItems)
    .where(eq(menuItems.id, itemId));
  if (!item) return;
  await db
    .update(menuItems)
    .set({ isAvailable: !item.isAvailable, updatedAt: new Date() })
    .where(eq(menuItems.id, itemId));
  revalidateMenu();
}

export async function deleteItem(formData: FormData): Promise<void> {
  await requireOperator();
  const itemId = idField(formData, "itemId");
  await db.delete(menuItems).where(eq(menuItems.id, itemId));
  revalidateMenu();
}

export async function moveItem(formData: FormData): Promise<void> {
  await requireOperator();
  const itemId = idField(formData, "itemId");
  const direction = directionField(formData);

  const [item] = await db
    .select({ categoryId: menuItems.categoryId })
    .from(menuItems)
    .where(eq(menuItems.id, itemId));
  if (!item) return;

  const list = await db
    .select({ id: menuItems.id, sortOrder: menuItems.sortOrder })
    .from(menuItems)
    .where(eq(menuItems.categoryId, item.categoryId))
    .orderBy(asc(menuItems.sortOrder), asc(menuItems.id));
  const index = list.findIndex((i) => i.id === itemId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index === -1 || target < 0 || target >= list.length) return;

  [list[index], list[target]] = [list[target], list[index]];
  for (let i = 0; i < list.length; i++) {
    if (list[i].sortOrder !== i) {
      await db
        .update(menuItems)
        .set({ sortOrder: i })
        .where(eq(menuItems.id, list[i].id));
    }
  }
  revalidateMenu();
}

const itemSchema = z.object({
  name: z.string().trim().min(1, "Item name is required").max(200),
  description: z.string().trim().max(2000),
  categoryId: z.number().int().positive("Choose a category"),
  basePriceCents: z.number().int().min(0),
  isAvailable: z.boolean(),
  isFeatured: z.boolean(),
});

/** Create or update a menu item (hidden itemId field ⇒ update). */
export async function saveItem(formData: FormData): Promise<void> {
  await requireOperator();

  const itemIdRaw = textField(formData, "itemId");
  const itemId = itemIdRaw ? Number.parseInt(itemIdRaw, 10) : null;
  const data = itemSchema.parse({
    name: textField(formData, "name"),
    description: textField(formData, "description"),
    categoryId: Number.parseInt(textField(formData, "categoryId"), 10),
    basePriceCents: dollarsToCents(formData, "price"),
    isAvailable: checkbox(formData, "isAvailable"),
    isFeatured: checkbox(formData, "isFeatured"),
  });
  const groupIds = [
    ...new Set(
      formData
        .getAll("groupIds")
        .map((v) => Number.parseInt(String(v), 10))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ];

  const values = {
    name: data.name,
    description: data.description || null,
    categoryId: data.categoryId,
    basePriceCents: data.basePriceCents,
    isAvailable: data.isAvailable,
    isFeatured: data.isFeatured,
  };

  let savedId: number;
  if (itemId) {
    const [existing] = await db
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(eq(menuItems.id, itemId));
    if (!existing) throw new Error("Item not found");
    await db
      .update(menuItems)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(menuItems.id, itemId));
    await db
      .delete(itemModifierGroups)
      .where(eq(itemModifierGroups.itemId, itemId));
    savedId = itemId;
  } else {
    const [last] = await db
      .select({ sortOrder: menuItems.sortOrder })
      .from(menuItems)
      .where(eq(menuItems.categoryId, data.categoryId))
      .orderBy(desc(menuItems.sortOrder))
      .limit(1);
    const [created] = await db
      .insert(menuItems)
      .values({ ...values, sortOrder: (last?.sortOrder ?? -1) + 1 })
      .returning({ id: menuItems.id });
    savedId = created.id;
  }

  if (groupIds.length > 0) {
    const groups = await db
      .select({ id: modifierGroups.id, sortOrder: modifierGroups.sortOrder })
      .from(modifierGroups)
      .where(inArray(modifierGroups.id, groupIds));
    if (groups.length > 0) {
      await db.insert(itemModifierGroups).values(
        groups.map((g) => ({
          itemId: savedId,
          groupId: g.id,
          sortOrder: g.sortOrder,
        })),
      );
    }
  }

  revalidateMenu();
  redirect("/admin/menu");
}

// ---------------------------------------------------------------------------
// Modifier groups
// ---------------------------------------------------------------------------

function parseGroupFields(fd: FormData): {
  name: string;
  minSelect: number;
  maxSelect: number | null;
} {
  const name = textField(fd, "name");
  if (!name) throw new Error("Group name is required");
  const minSelect = intField(fd, "minSelect", 0);
  const maxRaw = textField(fd, "maxSelect");
  let maxSelect: number | null =
    maxRaw === "" ? null : Number.parseInt(maxRaw, 10);
  if (maxSelect !== null && (!Number.isInteger(maxSelect) || maxSelect < 1)) {
    maxSelect = null;
  }
  if (maxSelect !== null && maxSelect < minSelect) maxSelect = minSelect;
  return { name, minSelect, maxSelect };
}

export async function createModifierGroup(formData: FormData): Promise<void> {
  await requireOperator();
  const fields = parseGroupFields(formData);
  const [last] = await db
    .select({ sortOrder: modifierGroups.sortOrder })
    .from(modifierGroups)
    .orderBy(desc(modifierGroups.sortOrder))
    .limit(1);
  await db
    .insert(modifierGroups)
    .values({ ...fields, sortOrder: (last?.sortOrder ?? -1) + 1 });
  revalidateModifiers();
}

export async function updateModifierGroup(formData: FormData): Promise<void> {
  await requireOperator();
  const groupId = idField(formData, "groupId");
  const fields = parseGroupFields(formData);
  await db
    .update(modifierGroups)
    .set(fields)
    .where(eq(modifierGroups.id, groupId));
  revalidateModifiers();
}

export async function deleteModifierGroup(formData: FormData): Promise<void> {
  await requireOperator();
  const groupId = idField(formData, "groupId");
  await db.delete(modifierGroups).where(eq(modifierGroups.id, groupId));
  revalidateModifiers();
  revalidateMenu();
}

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

/**
 * Default semantics: for single-select groups (maxSelect = 1) a default acts
 * like a radio — setting one clears the others in the group.
 */
async function applyDefault(
  groupId: number,
  modifierId: number,
  isDefault: boolean,
): Promise<void> {
  const [group] = await db
    .select({ maxSelect: modifierGroups.maxSelect })
    .from(modifierGroups)
    .where(eq(modifierGroups.id, groupId));
  if (isDefault && group?.maxSelect === 1) {
    await db
      .update(modifiers)
      .set({ isDefault: false })
      .where(eq(modifiers.groupId, groupId));
  }
  await db
    .update(modifiers)
    .set({ isDefault })
    .where(eq(modifiers.id, modifierId));
}

export async function createModifier(formData: FormData): Promise<void> {
  await requireOperator();
  const groupId = idField(formData, "groupId");
  const name = textField(formData, "name");
  if (!name) throw new Error("Modifier name is required");
  const priceDeltaCents = dollarsToCents(formData, "price");
  const isDefault = checkbox(formData, "isDefault");

  const [group] = await db
    .select({ id: modifierGroups.id, maxSelect: modifierGroups.maxSelect })
    .from(modifierGroups)
    .where(eq(modifierGroups.id, groupId));
  if (!group) return;

  if (isDefault && group.maxSelect === 1) {
    await db
      .update(modifiers)
      .set({ isDefault: false })
      .where(eq(modifiers.groupId, groupId));
  }
  const [last] = await db
    .select({ sortOrder: modifiers.sortOrder })
    .from(modifiers)
    .where(eq(modifiers.groupId, groupId))
    .orderBy(desc(modifiers.sortOrder))
    .limit(1);
  await db.insert(modifiers).values({
    groupId,
    name,
    priceDeltaCents,
    isDefault,
    sortOrder: (last?.sortOrder ?? -1) + 1,
  });
  revalidateModifiers();
}

export async function updateModifier(formData: FormData): Promise<void> {
  await requireOperator();
  const modifierId = idField(formData, "modifierId");
  const name = textField(formData, "name");
  if (!name) throw new Error("Modifier name is required");
  const priceDeltaCents = dollarsToCents(formData, "price");
  const isDefault = checkbox(formData, "isDefault");

  const [modifier] = await db
    .select({ id: modifiers.id, groupId: modifiers.groupId })
    .from(modifiers)
    .where(eq(modifiers.id, modifierId));
  if (!modifier) return;

  await db
    .update(modifiers)
    .set({ name, priceDeltaCents })
    .where(eq(modifiers.id, modifierId));
  await applyDefault(modifier.groupId, modifierId, isDefault);
  revalidateModifiers();
}

export async function toggleModifierDefault(formData: FormData): Promise<void> {
  await requireOperator();
  const modifierId = idField(formData, "modifierId");
  const [modifier] = await db
    .select({
      id: modifiers.id,
      groupId: modifiers.groupId,
      isDefault: modifiers.isDefault,
    })
    .from(modifiers)
    .where(eq(modifiers.id, modifierId));
  if (!modifier) return;
  await applyDefault(modifier.groupId, modifierId, !modifier.isDefault);
  revalidateModifiers();
}

export async function toggleModifierAvailability(
  formData: FormData,
): Promise<void> {
  await requireOperator();
  const modifierId = idField(formData, "modifierId");
  const [modifier] = await db
    .select({ isAvailable: modifiers.isAvailable })
    .from(modifiers)
    .where(eq(modifiers.id, modifierId));
  if (!modifier) return;
  await db
    .update(modifiers)
    .set({ isAvailable: !modifier.isAvailable })
    .where(eq(modifiers.id, modifierId));
  revalidateModifiers();
}

export async function deleteModifier(formData: FormData): Promise<void> {
  await requireOperator();
  const modifierId = idField(formData, "modifierId");
  await db.delete(modifiers).where(eq(modifiers.id, modifierId));
  revalidateModifiers();
}

// ---------------------------------------------------------------------------
// Store settings
// ---------------------------------------------------------------------------

const TIME_RE = /^\d{2}:\d{2}$/;

/**
 * Only an https URL is accepted, so a hostile value can't turn the logo into a
 * `javascript:` or other active-content URL. Uploads don't come through here —
 * they POST to /api/admin/logo.
 */
function logoUrlOrNull(formData: FormData): string | null {
  const raw = textField(formData, "logoUrl");
  if (!raw) return null;
  return /^https:\/\/\S+$/i.test(raw) ? raw : null;
}

export async function saveSettings(formData: FormData): Promise<void> {
  await requireOperator();

  const taxPercentRaw = textField(formData, "taxPercent");
  const taxPercent = taxPercentRaw === "" ? 0 : Number.parseFloat(taxPercentRaw);
  if (Number.isNaN(taxPercent) || taxPercent < 0 || taxPercent > 100) {
    throw new Error("Invalid tax rate");
  }

  const hours: DayHours[] = [];
  for (let day = 0; day < 7; day++) {
    const open = textField(formData, `open-${day}`);
    const close = textField(formData, `close-${day}`);
    hours.push({
      day,
      closed: checkbox(formData, `closed-${day}`),
      open: TIME_RE.test(open) ? open : "11:00",
      close: TIME_RE.test(close) ? close : "21:00",
    });
  }

  const logoUrl = logoUrlOrNull(formData);
  // A pasted URL replaces an upload — the storefront prefers the upload, so
  // leaving it in place would silently ignore what the operator just saved.
  if (logoUrl) {
    await db.delete(storeLogo).where(eq(storeLogo.id, 1));
  }

  const values = {
    name: textField(formData, "name") || "My Pizzeria",
    tagline: textOrNull(formData, "tagline"),
    logoUrl,
    ...(logoUrl ? { logoUploadedAt: null } : {}),
    phone: textOrNull(formData, "phone"),
    email: textOrNull(formData, "email"),
    addressLine1: textOrNull(formData, "addressLine1"),
    addressLine2: textOrNull(formData, "addressLine2"),
    city: textOrNull(formData, "city"),
    state: textOrNull(formData, "state"),
    zip: textOrNull(formData, "zip"),
    hours,
    pickupEnabled: checkbox(formData, "pickupEnabled"),
    deliveryEnabled: checkbox(formData, "deliveryEnabled"),
    pickupPrepMinutes: intField(formData, "pickupPrepMinutes", 20),
    deliveryPrepMinutes: intField(formData, "deliveryPrepMinutes", 45),
    kdsWarnMinutes: Math.max(1, intField(formData, "kdsWarnMinutes", 10)),
    kdsLateMinutes: Math.max(1, intField(formData, "kdsLateMinutes", 15)),
    kdsOvenMinutes: Math.max(1, intField(formData, "kdsOvenMinutes", 7)),
    deliveryFeeCents: dollarsToCents(formData, "deliveryFee"),
    deliveryMinimumCents: dollarsToCents(formData, "deliveryMinimum"),
    taxRateBps: Math.round(taxPercent * 100),
    updatedAt: new Date(),
  };

  await db
    .insert(storeSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: storeSettings.id, set: values });

  revalidatePath("/");
  revalidatePath("/admin/settings");
  redirect("/admin/settings?saved=1");
}

export async function togglePublished(): Promise<void> {
  await requireOperator();
  const [settings] = await db
    .select({ isPublished: storeSettings.isPublished })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  if (!settings) return;
  await db
    .update(storeSettings)
    .set({ isPublished: !settings.isPublished, updatedAt: new Date() })
    .where(eq(storeSettings.id, 1));
  revalidatePath("/");
  revalidatePath("/admin/settings");
}

export async function toggleAcceptingOrders(): Promise<void> {
  await requireOperator();
  const [settings] = await db
    .select({ isAcceptingOrders: storeSettings.isAcceptingOrders })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  if (!settings) return;
  await db
    .update(storeSettings)
    .set({
      isAcceptingOrders: !settings.isAcceptingOrders,
      updatedAt: new Date(),
    })
    .where(eq(storeSettings.id, 1));
  revalidatePath("/");
  revalidatePath("/admin/settings");
}
