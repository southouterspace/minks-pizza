import "server-only";
import { eq } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db, storeSettings } from "@/db";
import { DEFAULT_STAFF_RULES, DEFAULT_TIMEZONE, type StaffRules } from "@/lib/timeclock";
import { localDateOf, localDateSchema, toWeekday, weekStartOf, type LocalDate } from "@/lib/zoned";

export type StaffConfig = { storeName: string; timezone: string; rules: StaffRules };

const RULE_COLUMNS = {
  weekStartsOn: storeSettings.weekStartsOn,
  otWeeklyMinutes: storeSettings.otWeeklyMinutes,
  otDailyMinutes: storeSettings.otDailyMinutes,
  dtDailyMinutes: storeSettings.dtDailyMinutes,
  breakRequiredAfterMinutes: storeSettings.breakRequiredAfterMinutes,
  clockGraceMinutes: storeSettings.clockGraceMinutes,
  earlyClockInMinutes: storeSettings.earlyClockInMinutes,
} satisfies Record<keyof StaffRules, PgColumn>;

export async function getStaffConfig(): Promise<StaffConfig> {
  const [row] = await db
    .select({ storeName: storeSettings.name, timezone: storeSettings.timezone, ...RULE_COLUMNS })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  if (!row) return { storeName: "Mink's Pizza", timezone: DEFAULT_TIMEZONE, rules: DEFAULT_STAFF_RULES };
  const { storeName, timezone, weekStartsOn, ...rules } = row;
  return { storeName, timezone, rules: { ...rules, weekStartsOn: toWeekday(weekStartsOn, DEFAULT_STAFF_RULES.weekStartsOn) } };
}

/** `?week=` snapped to the store's payroll week start; anything unparsable is this week. */
export function resolveWeek(param: unknown, cfg: StaffConfig, now = new Date()): LocalDate {
  const parsed = localDateSchema.safeParse(param);
  return weekStartOf(parsed.success ? parsed.data : localDateOf(now, cfg.timezone), cfg.rules.weekStartsOn);
}
