import type { DayHours } from "@/db/schema";
import { hhmmMinutes } from "@/lib/zoned";

/** Open/closed per the viewer's local clock (informational, not enforced). */
export function isOpenNow(hours: DayHours[] | null, now = new Date()): boolean | null {
  if (!hours || hours.length === 0) return null;
  const today = hours.find((h) => h.day === now.getDay());
  if (!today || today.closed) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= hhmmMinutes(today.open) && minutes < hhmmMinutes(today.close);
}
