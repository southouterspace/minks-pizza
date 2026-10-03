"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { db, orderDiscounts, promotionCodes, promotions } from "@/db";
import { requireOperator } from "@/lib/auth";
import { getSettings } from "@/lib/orders";
import { displayCode, normalizeCode } from "@/lib/promo-code";
import { promotionColumns, promotionInputSchema } from "@/lib/promotion-schema";

export type PromotionFormState = { error?: string; field?: string };

const promotionId = z.number().int().positive();

function revalidatePromotions() {
  revalidatePath("/admin/promotions", "layout");
  revalidatePath("/");
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === "23505") return true;
  }
  return false;
}

/** Creates or updates; past orders keep their own snapshot of the deal. */
export async function savePromotion(
  id: number | null,
  input: unknown,
  sharedCode?: string,
): Promise<PromotionFormState> {
  await requireOperator();
  const parsed = promotionInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue?.message ?? "Check the form.", field: issue?.path.join(".") };
  }
  const { timezone } = await getSettings();
  const values = { ...promotionColumns(parsed.data, timezone), updatedAt: new Date() };

  let savedId: number;
  if (id === null) {
    const code = parsed.data.trigger === "code" ? displayCode(sharedCode ?? "") : "";
    if (code) {
      const problem = codeProblem(code);
      if (problem) return { error: problem, field: "code" };
    }
    try {
      // One transaction, so a taken code never leaves a half-made deal behind.
      const [[row]] = await db.batch([
        db.insert(promotions).values(values).returning({ id: promotions.id }),
        ...(code
          ? [
              db.execute(sql`
                insert into promotion_codes (promotion_id, code, display)
                select currval(pg_get_serial_sequence('promotions', 'id')), ${normalizeCode(code)}, ${code}`),
            ]
          : []),
      ]);
      savedId = row.id;
    } catch (err) {
      if (isUniqueViolation(err)) return { error: takenMessage(code), field: "code" };
      throw err;
    }
  } else {
    const ok = promotionId.safeParse(id);
    if (!ok.success) return { error: "Unknown promotion." };
    await db.update(promotions).set(values).where(eq(promotions.id, id));
    savedId = id;
  }
  revalidatePromotions();
  redirect(`/admin/promotions/${savedId}?saved=1`);
}

export async function setPromotionActive(id: number, active: boolean): Promise<void> {
  await requireOperator();
  await db
    .update(promotions)
    .set({ isActive: active, updatedAt: new Date() })
    .where(eq(promotions.id, promotionId.parse(id)));
  revalidatePromotions();
}

export async function archivePromotion(id: number, archived: boolean): Promise<void> {
  await requireOperator();
  await db
    .update(promotions)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(eq(promotions.id, promotionId.parse(id)));
  revalidatePromotions();
}

/**
 * Only for a deal no order ever used, checked in the delete itself so an
 * order placed meanwhile can't lose its link. Used ones are archived so
 * reports keep them.
 */
export async function deletePromotion(id: number): Promise<PromotionFormState> {
  await requireOperator();
  const pid = promotionId.parse(id);
  const deleted = await db
    .delete(promotions)
    .where(and(eq(promotions.id, pid), notExists(db.select().from(orderDiscounts).where(eq(orderDiscounts.promotionId, pid)))))
    .returning({ id: promotions.id });
  if (deleted.length === 0) return { error: "Orders used this deal, so it can only be archived." };
  revalidatePromotions();
  redirect("/admin/promotions");
}

function takenMessage(code: string): string {
  return `${code} is already taken. Codes match ignoring dashes and case, so pick another.`;
}

function codeProblem(code: string): string | null {
  const normalized = normalizeCode(code);
  if (normalized.length < 3) return "Codes need at least 3 letters or digits.";
  if (normalized.length > 30) return "Keep codes under 30 characters.";
  if (!/^[A-Z0-9]+$/.test(normalized)) return "Use letters, digits and dashes only.";
  return null;
}

export async function addSharedCode(id: number, code: string): Promise<PromotionFormState> {
  await requireOperator();
  const display = displayCode(code);
  const problem = codeProblem(display);
  if (problem) return { error: problem };
  try {
    await db
      .insert(promotionCodes)
      .values({ promotionId: promotionId.parse(id), code: normalizeCode(display), display });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: takenMessage(display) };
    throw err;
  }
  revalidatePromotions();
  return {};
}

// No 0/O or 1/I: these get read aloud and typed from mailers.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function randomChunk(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** N single-use codes like MINK-7KQ2-X9, retrying the rare collision. */
export async function generateCodes(id: number, count: number, prefix: string): Promise<PromotionFormState> {
  await requireOperator();
  const pid = promotionId.parse(id);
  const n = z.number().int().min(1).max(1000).safeParse(count);
  if (!n.success) return { error: "Generate between 1 and 1,000 codes at a time." };
  const head = prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "MINK";
  let remaining = n.data;
  for (let round = 0; remaining > 0 && round < 5; round++) {
    const batch = Array.from({ length: remaining }, () => {
      const display = `${head}-${randomChunk(4)}-${randomChunk(2)}`;
      return { promotionId: pid, code: normalizeCode(display), display, maxUses: 1 };
    });
    const inserted = await db
      .insert(promotionCodes)
      .values(batch)
      .onConflictDoNothing({ target: promotionCodes.code })
      .returning({ id: promotionCodes.id });
    remaining -= inserted.length;
  }
  revalidatePromotions();
  return remaining > 0 ? { error: `Generated ${n.data - remaining}; try again for the rest.` } : {};
}

/** Kills a code (say, a leaked one). Past orders keep their discount lines. */
export async function deleteCode(id: number, codeId: number): Promise<void> {
  await requireOperator();
  await db
    .delete(promotionCodes)
    .where(and(eq(promotionCodes.id, promotionId.parse(codeId)), eq(promotionCodes.promotionId, promotionId.parse(id))));
  revalidatePath(`/admin/promotions/${promotionId.parse(id)}`);
}
