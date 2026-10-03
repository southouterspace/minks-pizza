"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, loyaltyMembers, loyaltyPromotions, loyaltyRewards, loyaltySettings } from "@/db";
import { requireOperator } from "@/lib/auth";
import { formFields, idField } from "@/lib/form-data";
import { birthdaySchema, localYearMonth, repriceReward, tiersSchema } from "@/lib/loyalty";
import {
  claimOrderByNumber,
  getReward,
  isInsufficientPoints,
  ledgerKey,
  ledgerStatement,
  restoreExpiry,
  seedDefaultRewards,
} from "@/lib/loyalty-server";
import { parseDollars } from "@/lib/money";
import { getSettings } from "@/lib/orders";
import { rejected, type LoyaltyFormState } from "./form-state";

// Each form's schema is keyed by the form's own field names, so `rejected`
// can put every error beside the field it is about.

/** "1.5" (x) → 15000 bps. */
const multiplierBps = z.coerce
  .number({ message: "Enter a multiplier like 1.5" })
  .min(1, "Multipliers start at 1x")
  .max(10, "Multipliers go up to 10x")
  .transform((x) => Math.round(x * 10_000));

const dollarsToCents = z
  .string()
  .transform((d) => parseDollars(d) ?? Number.NaN)
  .pipe(z.number({ message: "Enter an amount like 3.50" }).positive("Enter an amount above $0").max(100_000));

const points = z.coerce
  .number({ message: "Enter a whole number" })
  .int("Enter a whole number")
  .min(0, "Use 0 or more points")
  .max(100_000, "Use at most 100,000 points");

const checkbox = z
  .literal("on")
  .optional()
  .transform((v) => v === "on");

/** A blank hidden id is a new row. */
const optionalId = z
  .string()
  .optional()
  .transform((v) => (v ? Number.parseInt(v, 10) : null))
  .pipe(z.number().int().positive().nullable());

function revalidateLoyalty() {
  revalidatePath("/admin/loyalty", "layout");
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

export async function toggleLoyaltyEnabled(): Promise<void> {
  await requireOperator();
  const [settings] = await db
    .insert(loyaltySettings)
    .values({ id: 1, enabled: true })
    .onConflictDoUpdate({
      target: loyaltySettings.id,
      set: { enabled: sql`not ${loyaltySettings.enabled}`, updatedAt: new Date() },
    })
    .returning({ enabled: loyaltySettings.enabled });
  if (settings.enabled) await seedDefaultRewards();
  revalidateLoyalty();
}

const settingsForm = z.object({
  programName: z.string().min(1, "Name the program").max(60),
  pointsPerDollar: z.coerce.number().int().min(1, "Earn at least 1 point per dollar").max(1000),
  signupBonus: points,
  birthdayPoints: points,
  referrerBonus: points,
  refereeBonus: points,
  expirationMonths: z.union([
    z.literal("").transform(() => null),
    z.coerce.number().int().min(1, "Use 1 to 60 months, or leave it blank").max(60, "Use 1 to 60 months, or leave it blank"),
  ]),
});

const tierRow = (i: number) =>
  z
    .object({
      [`tier-name-${i}`]: z.string().max(40),
      [`tier-min-${i}`]: z.string().regex(/^\d+$/, "Enter the points this tier starts at").transform(Number),
      [`tier-multiplier-${i}`]: multiplierBps,
    })
    .transform((row) => ({
      name: row[`tier-name-${i}`] as string,
      minPoints: row[`tier-min-${i}`] as number,
      multiplierBps: row[`tier-multiplier-${i}`] as number,
    }));

export async function saveLoyaltySettings(_prev: LoyaltyFormState, formData: FormData): Promise<LoyaltyFormState> {
  await requireOperator();
  const fields = formFields(formData);
  const settings = settingsForm.safeParse(fields);
  if (!settings.success) return rejected(formData, settings.error);

  const rows = [];
  for (let i = 0; formData.has(`tier-name-${i}`); i++) {
    if (!fields[`tier-name-${i}`]) continue; // a blank name removes the row
    const row = tierRow(i).safeParse(fields);
    if (!row.success) return rejected(formData, row.error);
    rows.push(row.data);
  }
  const tiers = tiersSchema.safeParse(rows);
  if (!tiers.success) return rejected(formData, tiers.error.issues[0].message);

  const values = { ...settings.data, tiers: tiers.data, updatedAt: new Date() };
  await db
    .insert(loyaltySettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: loyaltySettings.id, set: values });
  revalidateLoyalty();
  return { notice: "Program settings saved." };
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

const rewardFields = z.object({
  id: optionalId,
  name: z.string().min(1, "Name the reward").max(80),
  description: z
    .string()
    .max(200)
    .transform((d) => d || null),
  pointsCost: z.coerce
    .number({ message: "Enter a whole number of points" })
    .int("Enter a whole number of points")
    .min(1, "A reward costs at least 1 point")
    .max(1_000_000),
  sortOrder: z.coerce.number().int().min(0).max(1000).catch(0),
  isActive: checkbox,
});

const rewardForm = z
  .discriminatedUnion("effectKind", [
    rewardFields.extend({ effectKind: z.literal("amount_off"), amountOff: dollarsToCents }),
    rewardFields.extend({
      effectKind: z.literal("free_item"),
      maxValue: dollarsToCents,
      categoryIds: z.array(z.coerce.number().int().positive()).min(1, "Pick at least one category"),
    }),
  ])
  .transform((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    pointsCost: r.pointsCost,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    effect:
      r.effectKind === "amount_off"
        ? { kind: "amount_off" as const, amountOffCents: r.amountOff }
        : { kind: "free_item" as const, categoryIds: r.categoryIds, maxValueCents: r.maxValue },
  }));

export async function saveReward(_prev: LoyaltyFormState, formData: FormData): Promise<LoyaltyFormState> {
  await requireOperator();
  const parsed = rewardForm.safeParse({ categoryIds: [], ...formFields(formData, ["categoryIds"]) });
  if (!parsed.success) return rejected(formData, parsed.error);
  const { id, ...reward } = parsed.data;

  if (id === null) {
    await db.insert(loyaltyRewards).values(reward);
  } else {
    const existing = await getReward(id);
    if (!existing) return rejected(formData, "That reward was deleted. Refresh the page.");
    await db
      .update(loyaltyRewards)
      .set({ ...reward, ...repriceReward(existing, reward.pointsCost, new Date()) })
      .where(eq(loyaltyRewards.id, id));
  }
  revalidateLoyalty();
  return { notice: id === null ? "Reward added." : "Reward saved." };
}

/**
 * Orders keep the reward's name, not a reference, so removing a reward never
 * rewrites history.
 */
export async function deleteReward(formData: FormData): Promise<void> {
  await requireOperator();
  await db.delete(loyaltyRewards).where(eq(loyaltyRewards.id, idField(formData, "id")));
  revalidateLoyalty();
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

const isoDate = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2})?$/, "Use a full date")
  .transform((d) => d || null);

const promotionForm = z
  .object({
    id: optionalId,
    name: z.string().min(1, "Name the promotion").max(80),
    multiplier: multiplierBps.refine((bps) => bps > 10_000, "A promotion must multiply points by more than 1x"),
    daysOfWeek: z.array(z.coerce.number().int().min(0).max(6)),
    startsOn: isoDate,
    endsOn: isoDate,
    isActive: checkbox,
  })
  .refine((p) => !p.startsOn || !p.endsOn || p.startsOn <= p.endsOn, {
    message: "The end date is before the start date",
    path: ["endsOn"],
  });

export async function savePromotion(_prev: LoyaltyFormState, formData: FormData): Promise<LoyaltyFormState> {
  await requireOperator();
  const parsed = promotionForm.safeParse({ daysOfWeek: [], ...formFields(formData, ["daysOfWeek"]) });
  if (!parsed.success) return rejected(formData, parsed.error);
  const { id, multiplier, ...promo } = parsed.data;
  const values = { ...promo, multiplierBps: multiplier };

  if (id === null) {
    await db.insert(loyaltyPromotions).values(values);
  } else {
    const updated = await db
      .update(loyaltyPromotions)
      .set(values)
      .where(eq(loyaltyPromotions.id, id))
      .returning({ id: loyaltyPromotions.id });
    if (updated.length === 0) return rejected(formData, "That promotion was deleted. Refresh the page.");
  }
  revalidateLoyalty();
  return { notice: id === null ? "Promotion added." : "Promotion saved." };
}

export async function deletePromotion(formData: FormData): Promise<void> {
  await requireOperator();
  await db.delete(loyaltyPromotions).where(eq(loyaltyPromotions.id, idField(formData, "id")));
  revalidateLoyalty();
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

const adjustForm = z.object({
  memberId: z.coerce.number().int().positive(),
  points: z.coerce
    .number({ message: "Enter a whole number of points" })
    .int("Enter a whole number of points")
    .refine((p) => p !== 0, "Enter a number of points other than 0")
    .refine((p) => Math.abs(p) <= 100_000, "That's more than 100,000 points"),
  reason: z.string().min(1, "Give a reason for the adjustment").max(200),
});

export async function adjustPoints(_prev: LoyaltyFormState, formData: FormData): Promise<LoyaltyFormState> {
  const operator = await requireOperator();
  const parsed = adjustForm.safeParse(formFields(formData));
  if (!parsed.success) return rejected(formData, parsed.error);
  try {
    await ledgerStatement({
      kind: "adjust",
      idemKey: ledgerKey.adjust(),
      from: { memberId: parsed.data.memberId, points: parsed.data.points },
      note: parsed.data.reason,
      operatorId: operator.id,
    });
  } catch (err) {
    if (isInsufficientPoints(err)) return rejected(formData, "That would take the balance below zero.");
    throw err;
  }
  revalidateLoyalty();
  return { notice: "Points adjusted." };
}

/** Gives back points that expired in the last 30 days; once per expiry. */
export async function restoreExpired(formData: FormData): Promise<void> {
  const operator = await requireOperator();
  await restoreExpiry(idField(formData, "entryId"), operator.id);
  revalidateLoyalty();
}

/** Same key as the automatic grant, so it can't pay twice in a year. */
export async function issueBirthdayBonus(_prev: LoyaltyFormState, formData: FormData): Promise<LoyaltyFormState> {
  const operator = await requireOperator();
  const memberId = idField(formData, "memberId");
  const year = localYearMonth(new Date(), (await getSettings()).timezone).year;
  const { rowCount } = await ledgerStatement({
    kind: "birthday",
    idemKey: ledgerKey.birthday(memberId, year),
    from: sql`select ${memberId}::int as member_id, ${loyaltySettings.birthdayPoints} as points
              from ${loyaltySettings} where ${loyaltySettings.id} = 1`,
    note: "Issued by the store",
    operatorId: operator.id,
  });
  if (rowCount === 0) return rejected(formData, "This year's birthday bonus was already issued.");
  revalidateLoyalty();
  return { notice: "Birthday bonus issued." };
}

const CLAIM_ERRORS = {
  not_found: "No order has that number.",
  not_completed: "That order isn't completed yet. Points post when it is.",
  already_linked: "That order already belongs to a member.",
} as const;

const ORDER_NUMBER = "Enter an order number, like 1042.";

const claimForm = z.object({
  memberId: z.coerce.number().int().positive(),
  orderNumber: z
    .string()
    .transform((n) => n.replace(/^#/, ""))
    .transform(Number)
    .pipe(z.number({ message: ORDER_NUMBER }).int(ORDER_NUMBER).positive(ORDER_NUMBER)),
});

export async function addMissingOrder(_prev: LoyaltyFormState, formData: FormData): Promise<LoyaltyFormState> {
  await requireOperator();
  const parsed = claimForm.safeParse(formFields(formData));
  if (!parsed.success) return rejected(formData, parsed.error);
  const result = await claimOrderByNumber(parsed.data.memberId, parsed.data.orderNumber);
  if (result !== "claimed") return rejected(formData, CLAIM_ERRORS[result]);
  revalidateLoyalty();
  return { notice: "Order added and its points posted." };
}

export async function saveMemberBirthday(_prev: LoyaltyFormState, formData: FormData): Promise<LoyaltyFormState> {
  await requireOperator();
  const memberId = idField(formData, "memberId");
  const parsed = birthdaySchema.safeParse(formFields(formData));
  if (!parsed.success) return rejected(formData, parsed.error);
  await db
    .update(loyaltyMembers)
    .set({
      birthMonth: parsed.data.month,
      birthDay: parsed.data.day,
      birthdaySetAt: sql`coalesce(${loyaltyMembers.birthdaySetAt}, now())`,
    })
    .where(eq(loyaltyMembers.id, memberId));
  revalidateLoyalty();
  return { notice: "Birthday saved." };
}
