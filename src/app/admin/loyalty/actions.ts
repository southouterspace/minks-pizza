"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  loyaltyLedger,
  loyaltyMembers,
  loyaltyPromotions,
  loyaltyRewards,
  loyaltySettings,
} from "@/db";
import { requireOperator } from "@/lib/auth";
import {
  birthdaySchema,
  localDate,
  repriceReward,
  rewardEffectSchema,
  tiersSchema,
} from "@/lib/loyalty";
import {
  getLoyaltySettings,
  claimOrderByNumber,
  getReward,
  isInsufficientPoints,
  ledgerKey,
  ledgerStatement,
  restoreExpiry,
  seedDefaultRewards,
} from "@/lib/loyalty-server";

const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === "string" ? v.trim() : "";
};

/** "1.5" (x) → 15000 bps. */
const multiplierBps = z.coerce
  .number()
  .min(1, "Multipliers start at 1x")
  .max(10)
  .transform((x) => Math.round(x * 10_000));

const dollarsToCents = z.coerce
  .number()
  .positive("Enter an amount above $0")
  .max(1000)
  .transform((d) => Math.round(d * 100));

const points = z.coerce.number().int().min(0).max(100_000);

function fail(path: string, error: z.ZodError | string): never {
  const message = typeof error === "string" ? error : (error.issues[0]?.message ?? "Check the form.");
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function revalidateLoyalty() {
  revalidatePath("/admin/loyalty", "layout");
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

export async function toggleLoyaltyEnabled(): Promise<void> {
  await requireOperator();
  const settings = await getLoyaltySettings();
  await db
    .update(loyaltySettings)
    .set({ enabled: !settings.enabled, updatedAt: new Date() })
    .where(eq(loyaltySettings.id, 1));
  if (!settings.enabled) await seedDefaultRewards();
  revalidateLoyalty();
}

const settingsSchema = z.object({
  programName: z.string().trim().min(1, "Name the program").max(60),
  pointsPerDollar: z.coerce.number().int().min(1, "Earn at least 1 point per dollar").max(1000),
  signupBonus: points,
  birthdayPoints: points,
  referrerBonus: points,
  refereeBonus: points,
  expirationMonths: z.union([z.literal("never").transform(() => null), z.coerce.number().int().min(1).max(60)]),
  timezone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown timezone"),
  tiers: tiersSchema,
});

export async function saveLoyaltySettings(formData: FormData): Promise<void> {
  await requireOperator();
  const tiers = [];
  for (let i = 0; formData.has(`tier-name-${i}`); i++) {
    const name = text(formData, `tier-name-${i}`);
    if (!name) continue;
    const multiplier = multiplierBps.safeParse(text(formData, `tier-multiplier-${i}`));
    if (!multiplier.success) fail("/admin/loyalty/settings", multiplier.error);
    tiers.push({
      name,
      minPoints: Number.parseInt(text(formData, `tier-min-${i}`) || "0", 10),
      multiplierBps: multiplier.data,
    });
  }
  const parsed = settingsSchema.safeParse({
    programName: text(formData, "programName"),
    pointsPerDollar: text(formData, "pointsPerDollar"),
    signupBonus: text(formData, "signupBonus"),
    birthdayPoints: text(formData, "birthdayPoints"),
    referrerBonus: text(formData, "referrerBonus"),
    refereeBonus: text(formData, "refereeBonus"),
    expirationMonths: text(formData, "expirationMonths") || "never",
    timezone: text(formData, "timezone"),
    tiers: tiers.toSorted((a, b) => a.minPoints - b.minPoints),
  });
  if (!parsed.success) fail("/admin/loyalty/settings", parsed.error);

  await getLoyaltySettings();
  await db
    .update(loyaltySettings)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(loyaltySettings.id, 1));
  revalidateLoyalty();
  redirect("/admin/loyalty/settings?saved=1");
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

const rewardSchema = z.object({
  name: z.string().trim().min(1, "Name the reward").max(80),
  description: z.string().trim().max(200).transform((d) => d || null),
  pointsCost: z.coerce.number().int().min(1, "A reward costs at least 1 point").max(1_000_000),
  sortOrder: z.coerce.number().int().min(0).max(1000),
  isActive: z.boolean(),
  effect: rewardEffectSchema,
});

function rewardEffectFromForm(fd: FormData) {
  if (text(fd, "effectKind") === "free_item") {
    const max = dollarsToCents.safeParse(text(fd, "maxValue"));
    return {
      kind: "free_item" as const,
      categoryIds: fd.getAll("categoryIds").map(Number),
      maxValueCents: max.success ? max.data : 0,
    };
  }
  const off = dollarsToCents.safeParse(text(fd, "amountOff"));
  return { kind: "amount_off" as const, amountOffCents: off.success ? off.data : 0 };
}

export async function saveReward(formData: FormData): Promise<void> {
  await requireOperator();
  const parsed = rewardSchema.safeParse({
    name: text(formData, "name"),
    description: text(formData, "description"),
    pointsCost: text(formData, "pointsCost"),
    sortOrder: text(formData, "sortOrder") || "0",
    isActive: formData.get("isActive") === "on",
    effect: rewardEffectFromForm(formData),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(
      "/admin/loyalty/rewards",
      issue?.path[0] === "effect"
        ? "Set the discount amount, or pick at least one category and a maximum value."
        : parsed.error,
    );
  }

  const id = Number.parseInt(text(formData, "id"), 10);
  const existing = Number.isInteger(id) && id > 0 ? await getReward(id) : null;
  if (existing) {
    await db
      .update(loyaltyRewards)
      .set({ ...parsed.data, ...repriceReward(existing, parsed.data.pointsCost, new Date()) })
      .where(eq(loyaltyRewards.id, id));
  } else {
    await db.insert(loyaltyRewards).values(parsed.data);
  }
  revalidateLoyalty();
  redirect("/admin/loyalty/rewards?saved=1");
}

/**
 * Orders keep the reward's name, not a reference, so removing a reward never
 * rewrites history.
 */
export async function deleteReward(formData: FormData): Promise<void> {
  await requireOperator();
  const id = z.coerce.number().int().positive().parse(text(formData, "id"));
  await db.delete(loyaltyRewards).where(eq(loyaltyRewards.id, id));
  revalidateLoyalty();
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

const isoDate = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2})?$/, "Use a full date")
  .transform((d) => d || null);

const promotionSchema = z
  .object({
    name: z.string().trim().min(1, "Name the promotion").max(80),
    multiplierBps,
    daysOfWeek: z.array(z.coerce.number().int().min(0).max(6)),
    startsOn: isoDate,
    endsOn: isoDate,
    isActive: z.boolean(),
  })
  .refine((p) => p.multiplierBps > 10_000, "A promotion must multiply points by more than 1x")
  .refine((p) => !p.startsOn || !p.endsOn || p.startsOn <= p.endsOn, "The end date is before the start date");

export async function savePromotion(formData: FormData): Promise<void> {
  await requireOperator();
  const parsed = promotionSchema.safeParse({
    name: text(formData, "name"),
    multiplierBps: text(formData, "multiplier"),
    daysOfWeek: formData.getAll("daysOfWeek"),
    startsOn: text(formData, "startsOn"),
    endsOn: text(formData, "endsOn"),
    isActive: formData.get("isActive") === "on",
  });
  if (!parsed.success) fail("/admin/loyalty/promotions", parsed.error);

  const id = Number.parseInt(text(formData, "id"), 10);
  if (Number.isInteger(id) && id > 0) {
    await db.update(loyaltyPromotions).set(parsed.data).where(eq(loyaltyPromotions.id, id));
  } else {
    await db.insert(loyaltyPromotions).values(parsed.data);
  }
  revalidateLoyalty();
  redirect("/admin/loyalty/promotions?saved=1");
}

export async function deletePromotion(formData: FormData): Promise<void> {
  await requireOperator();
  const id = z.coerce.number().int().positive().parse(text(formData, "id"));
  await db.delete(loyaltyPromotions).where(eq(loyaltyPromotions.id, id));
  revalidateLoyalty();
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

const adjustSchema = z.object({
  memberId: z.coerce.number().int().positive(),
  points: z.coerce
    .number({ message: "Enter a whole number of points" })
    .int("Enter a whole number of points")
    .refine((p) => p !== 0, "Enter a number of points other than 0")
    .refine((p) => Math.abs(p) <= 100_000, "That's more than 100,000 points"),
  reason: z.string().trim().min(1, "Give a reason for the adjustment").max(200),
});

export async function adjustPoints(formData: FormData): Promise<void> {
  const operator = await requireOperator();
  const memberPath = `/admin/loyalty/members/${text(formData, "memberId")}`;
  const parsed = adjustSchema.safeParse({
    memberId: text(formData, "memberId"),
    points: text(formData, "points"),
    reason: text(formData, "reason"),
  });
  if (!parsed.success) fail(memberPath, parsed.error);

  try {
    await db.batch([
      ledgerStatement({
        kind: "adjust",
        idemKey: ledgerKey.adjust(),
        from: { memberId: parsed.data.memberId, points: parsed.data.points },
        note: parsed.data.reason,
        operatorId: operator.id,
      }),
    ]);
  } catch (err) {
    if (isInsufficientPoints(err)) fail(memberPath, "That would take the balance below zero.");
    throw err;
  }
  revalidateLoyalty();
  redirect(`${memberPath}?saved=adjusted`);
}

/** Gives back points that expired in the last 30 days; once per expiry. */
export async function restoreExpired(formData: FormData): Promise<void> {
  const operator = await requireOperator();
  const entryId = z.coerce.number().int().positive().parse(text(formData, "entryId"));
  const memberId = z.coerce.number().int().positive().parse(text(formData, "memberId"));
  await restoreExpiry(entryId, operator.id);
  revalidateLoyalty();
  redirect(`/admin/loyalty/members/${memberId}?saved=restored`);
}

/** Same key as the automatic grant, so it can't pay twice in a year. */
export async function issueBirthdayBonus(formData: FormData): Promise<void> {
  const operator = await requireOperator();
  const memberId = z.coerce.number().int().positive().parse(text(formData, "memberId"));
  const memberPath = `/admin/loyalty/members/${memberId}`;
  const settings = await getLoyaltySettings();
  const idemKey = ledgerKey.birthday(memberId, localDate(new Date(), settings.timezone).year);
  const [already] = await db
    .select({ id: loyaltyLedger.id })
    .from(loyaltyLedger)
    .where(eq(loyaltyLedger.idemKey, idemKey));
  if (already) fail(memberPath, "This year's birthday bonus was already issued.");
  await db.batch([
    ledgerStatement({
      kind: "birthday",
      idemKey,
      from: { memberId, points: settings.birthdayPoints },
      note: "Issued by the store",
      operatorId: operator.id,
    }),
  ]);
  revalidateLoyalty();
  redirect(`${memberPath}?saved=birthday-issued`);
}

const CLAIM_ERRORS = {
  not_found: "No order has that number.",
  not_completed: "That order isn't completed yet. Points post when it is.",
  already_linked: "That order already belongs to a member.",
} as const;

export async function addMissingOrder(formData: FormData): Promise<void> {
  await requireOperator();
  const memberId = z.coerce.number().int().positive().parse(text(formData, "memberId"));
  const memberPath = `/admin/loyalty/members/${memberId}`;
  const orderNumber = z.coerce.number().int().positive().safeParse(text(formData, "orderNumber").replace(/^#/, ""));
  if (!orderNumber.success) fail(memberPath, "Enter an order number, like 1042.");
  const result = await claimOrderByNumber(memberId, orderNumber.data);
  if (result !== "claimed") fail(memberPath, CLAIM_ERRORS[result]);
  revalidateLoyalty();
  redirect(`${memberPath}?saved=claimed`);
}

export async function saveMemberBirthday(formData: FormData): Promise<void> {
  await requireOperator();
  const memberId = z.coerce.number().int().positive().parse(text(formData, "memberId"));
  const birthday = birthdaySchema.safeParse({ month: text(formData, "month"), day: text(formData, "day") });
  if (!birthday.success) fail(`/admin/loyalty/members/${memberId}`, birthday.error);
  const { month, day } = birthday.data;
  await db
    .update(loyaltyMembers)
    .set({
      birthMonth: month,
      birthDay: day,
      birthdaySetAt: sql`coalesce(${loyaltyMembers.birthdaySetAt}, now())`,
    })
    .where(eq(loyaltyMembers.id, memberId));
  revalidateLoyalty();
  redirect(`/admin/loyalty/members/${memberId}?saved=birthday`);
}
