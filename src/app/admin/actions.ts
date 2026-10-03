"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  categories,
  db,
  ingredientPacks,
  ingredients,
  itemModifierGroups,
  menuItems,
  modifierGroups,
  modifiers,
  operators,
  recipeLines,
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
import { cancelCourier, dispatchCourier } from "@/lib/delivery/dispatch";
import { COURIER_PROVIDERS, CourierError } from "@/lib/delivery/types";
import { OrderError } from "@/lib/orders";
import { STORE_TIMEZONES } from "@/lib/hours";
import { MODIFIER_GROUP_KINDS, type ModifierGroupKind } from "@/lib/toppings";
import { unitFor } from "@/lib/unit-entry";
import { KITCHEN_STATIONS, type KitchenStation } from "@/lib/kds";
import { DEFAULT_STAFF_RULES, DEFAULT_TIMEZONE, parseStaffRules } from "@/lib/timeclock";
import {
  checkbox,
  dollarsToCents,
  idField,
  intField,
  textField,
  textOrNull,
} from "@/lib/form-data";
import {
  CANCEL_REASONS,
  ORDER_STATUSES,
  PAYMENT_METHODS,
} from "@/lib/order-workflow";
import {
  addOrderNote,
  adjustPromisedTime,
  applyDiscount,
  removeDiscount,
  recordPayment,
  transitionOrder,
  type Actor,
  type OrderActionResult,
} from "@/lib/order-writes";
import { compSchema } from "@/lib/validation";

export type AuthFormState = { error?: string };

function jsonField(fd: FormData, name: string): unknown {
  try {
    return JSON.parse(textField(fd, name));
  } catch {
    return null;
  }
}

/** Kitchen-display routing for a category; blank or unknown → "kitchen". */
function stationField(fd: FormData): KitchenStation {
  return z.enum(KITCHEN_STATIONS).catch("kitchen").parse(textField(fd, "station"));
}

function timezoneField(fd: FormData): string {
  const zones = STORE_TIMEZONES.map((tz) => tz.value);
  return z.enum(zones).catch(DEFAULT_TIMEZONE).parse(textField(fd, "timezone"));
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

export type OrderActionState = { error?: string };

async function operatorActor(): Promise<Actor> {
  const operator = await requireOperator();
  return { name: operator.name, operatorId: operator.id };
}

function orderActionState(result: OrderActionResult): OrderActionState {
  revalidatePath("/admin", "layout");
  return result.ok ? {} : { error: result.reason };
}

const orderIdField = (fd: FormData) => z.uuid().parse(textField(fd, "orderId"));

export async function moveOrder(formData: FormData): Promise<OrderActionState> {
  const actor = await operatorActor();
  const to = z.enum(ORDER_STATUSES).exclude(["canceled"]).parse(textField(formData, "to"));
  return orderActionState(
    await transitionOrder({ orderId: orderIdField(formData), to, actor }),
  );
}

export async function cancelOrder(formData: FormData): Promise<OrderActionState> {
  const actor = await operatorActor();
  const reason = z.enum(CANCEL_REASONS).safeParse(textField(formData, "reason"));
  if (!reason.success) return { error: "Pick a reason for canceling." };
  const detail = textField(formData, "detail").slice(0, 300);
  return orderActionState(
    await transitionOrder({
      orderId: orderIdField(formData),
      to: "canceled",
      actor,
      cancelReason: detail ? `${reason.data}: ${detail}` : reason.data,
    }),
  );
}

export async function adjustPromisedTimeAction(formData: FormData): Promise<OrderActionState> {
  const actor = await operatorActor();
  const minutes = z.coerce.number().int().min(-60).max(120).parse(textField(formData, "minutes"));
  return orderActionState(
    await adjustPromisedTime({ orderId: orderIdField(formData), minutes, actor }),
  );
}

export async function recordPaymentAction(formData: FormData): Promise<OrderActionState> {
  const actor = await operatorActor();
  const method = z.enum(PAYMENT_METHODS).parse(textField(formData, "method"));
  return orderActionState(
    await recordPayment({ orderId: orderIdField(formData), method, actor }),
  );
}

export async function addOrderNoteAction(formData: FormData): Promise<OrderActionState> {
  const actor = await operatorActor();
  const note = textField(formData, "note").slice(0, 500);
  if (!note) return { error: "Write a note first." };
  return orderActionState(
    await addOrderNote({ orderId: orderIdField(formData), note, actor }),
  );
}

export async function applyDiscountAction(formData: FormData): Promise<OrderActionState> {
  const actor = await operatorActor();
  const parsed = compSchema.safeParse({
    kind: textField(formData, "kind"),
    reason: textField(formData, "reason"),
    value: textField(formData, "value"),
    promotionId: textField(formData, "promotionId"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the discount." };
  return orderActionState(await applyDiscount({ orderId: orderIdField(formData), ...parsed.data, actor }));
}

export async function removeDiscountAction(formData: FormData): Promise<OrderActionState> {
  const actor = await operatorActor();
  return orderActionState(
    await removeDiscount({ orderId: orderIdField(formData), discountId: idField(formData, "discountId"), actor }),
  );
}

// ---------------------------------------------------------------------------
// Couriers
// ---------------------------------------------------------------------------

export type CourierFormState = { error?: string };

/** Runs a courier operation, turning its expected failures into a form error. */
async function courierAction(run: () => Promise<void>): Promise<CourierFormState> {
  await requireOperator();
  try {
    await run();
    return {};
  } catch (err) {
    if (err instanceof CourierError || err instanceof OrderError) return { error: err.message };
    throw err;
  } finally {
    revalidatePath("/admin");
  }
}

export async function requestCourier(
  _prev: CourierFormState,
  formData: FormData,
): Promise<CourierFormState> {
  return courierAction(() =>
    dispatchCourier(
      z.uuid().parse(textField(formData, "orderId")),
      z.enum(COURIER_PROVIDERS).parse(textField(formData, "provider")),
    ),
  );
}

export async function cancelCourierDelivery(
  _prev: CourierFormState,
  formData: FormData,
): Promise<CourierFormState> {
  return courierAction(() => cancelCourier(z.uuid().parse(textField(formData, "deliveryId"))));
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
  kind: ModifierGroupKind;
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
  const kind = z.enum(MODIFIER_GROUP_KINDS).catch("choice").parse(textField(fd, "kind"));
  return { name, kind, minSelect, maxSelect };
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

function extraPriceField(fd: FormData, kind: ModifierGroupKind): number | null {
  if (kind !== "toppings" || textField(fd, "extraPrice") === "") return null;
  return dollarsToCents(fd, "extraPrice");
}

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
    .select({ id: modifierGroups.id, maxSelect: modifierGroups.maxSelect, kind: modifierGroups.kind })
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
    extraPriceDeltaCents: extraPriceField(formData, group.kind),
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
    .select({ id: modifiers.id, groupId: modifiers.groupId, kind: modifierGroups.kind })
    .from(modifiers)
    .innerJoin(modifierGroups, eq(modifierGroups.id, modifiers.groupId))
    .where(eq(modifiers.id, modifierId));
  if (!modifier) return;

  await db
    .update(modifiers)
    .set({ name, priceDeltaCents, extraPriceDeltaCents: extraPriceField(formData, modifier.kind) })
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

export type RecipeActionState = { error?: string };

const recipeSchema = z.object({
  owner: z.enum(["item", "modifier"]),
  ownerId: z.coerce.number().int().positive(),
  lines: z.array(
    z.object({
      ingredientId: z.number().int().positive(),
      sizeModifierId: z.number().int().positive().nullable(),
      qty: z.number().finite(),
      unit: z.string(),
    }),
  ),
});

export async function saveRecipe(formData: FormData): Promise<RecipeActionState> {
  await requireOperator();
  const parsed = recipeSchema.safeParse({
    owner: textField(formData, "owner"),
    ownerId: textField(formData, "ownerId"),
    lines: jsonField(formData, "lines"),
  });
  if (!parsed.success) return { error: "Every quantity must be a number." };
  const { owner, ownerId, lines } = parsed.data;

  const ids = [...new Set(lines.map((l) => l.ingredientId))];
  const [found, packs, sizeIds] = await Promise.all([
    ids.length ? db.select().from(ingredients).where(inArray(ingredients.id, ids)) : [],
    ids.length
      ? db.select().from(ingredientPacks).where(inArray(ingredientPacks.ingredientId, ids))
      : [],
    db
      .select({ id: modifiers.id })
      .from(modifiers)
      .innerJoin(modifierGroups, eq(modifierGroups.id, modifiers.groupId))
      .where(eq(modifierGroups.kind, "size")),
  ]);
  const byId = new Map(found.map((i) => [i.id, i]));
  const sizes = new Set(sizeIds.map((s) => s.id));

  const rows: (typeof recipeLines.$inferInsert)[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const ingredient = byId.get(line.ingredientId);
    if (!ingredient) return { error: "An ingredient in this recipe no longer exists." };
    const unit = unitFor(
      line.unit,
      ingredient.baseUnit,
      packs.filter((p) => p.ingredientId === ingredient.id),
    );
    if (!unit) return { error: `${ingredient.name} can't be measured in ${line.unit}.` };
    if (line.sizeModifierId !== null && !sizes.has(line.sizeModifierId)) {
      return { error: "That size no longer exists." };
    }
    const qtyMilli = Math.round(line.qty * unit.baseQtyMilli);
    if (qtyMilli === 0) continue;
    if (qtyMilli < 0 && owner === "item") {
      return { error: `${ingredient.name}: only options can remove an ingredient.` };
    }
    const key = `${line.ingredientId}:${line.sizeModifierId}`;
    if (seen.has(key)) return { error: `${ingredient.name} is listed twice.` };
    seen.add(key);
    rows.push({
      menuItemId: owner === "item" ? ownerId : null,
      modifierId: owner === "modifier" ? ownerId : null,
      sizeModifierId: line.sizeModifierId,
      ingredientId: line.ingredientId,
      qtyMilli,
    });
  }

  const ownerColumn = owner === "item" ? recipeLines.menuItemId : recipeLines.modifierId;
  await db.batch([
    db.delete(recipeLines).where(eq(ownerColumn, ownerId)),
    ...(rows.length ? [db.insert(recipeLines).values(rows)] : []),
  ]);
  revalidatePath(owner === "item" ? `/admin/menu/items/${ownerId}` : "/admin/modifiers");
  return {};
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

function percentBps(fd: FormData, name: string, min: number, max: number): number {
  return Math.round(z.coerce.number().min(min).max(max).parse(textField(fd, name)) * 100);
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
    timezone: timezoneField(formData),
    halfToppingPriceBps: percentBps(formData, "halfToppingPricePct", 0, 100),
    halfPortionBps: percentBps(formData, "halfPortionPct", 0, 100),
    lightPortionBps: percentBps(formData, "lightPortionPct", 0, 100),
    extraPortionBps: percentBps(formData, "extraPortionPct", 100, 300),
    minMarginBps: percentBps(formData, "minMarginPct", 0, 100),
    weekStartsOn: Math.min(6, intField(formData, "weekStartsOn", DEFAULT_STAFF_RULES.weekStartsOn)),
    ...parseStaffRules((name) => textField(formData, name)),
    updatedAt: new Date(),
  };

  await db
    .insert(storeSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: storeSettings.id, set: values });

  revalidatePath("/");
  revalidatePath("/admin/settings");
  revalidatePath("/admin/staff", "layout");
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
