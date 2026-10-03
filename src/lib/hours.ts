import type { DayHours } from "@/db/schema";
import { hhmmMinutes } from "@/lib/zoned";

/** US zones offered in Settings; the store's day for stats and history. */
export const STORE_TIMEZONES = [
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Phoenix", label: "Arizona (no DST)" },
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
] as const;

/** Open/closed per the viewer's local clock (informational, not enforced). */
export function isOpenNow(hours: DayHours[] | null, now = new Date()): boolean | null {
  if (!hours || hours.length === 0) return null;
  const today = hours.find((h) => h.day === now.getDay());
  if (!today || today.closed) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= hhmmMinutes(today.open) && minutes < hhmmMinutes(today.close);
}
