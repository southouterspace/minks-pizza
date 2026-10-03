import type { Metadata, Viewport } from "next";
import { requireOperator } from "@/lib/auth";
import { getKioskBoard, getStaffConfig } from "@/lib/timeclock-server";
import { TimeClock } from "@/components/timeclock/time-clock";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Time clock" };

export const viewport: Viewport = { themeColor: "#09090b" };

export default async function TimeClockPage() {
  await requireOperator();
  const cfg = await getStaffConfig();
  return <TimeClock initial={await getKioskBoard(cfg)} storeName={cfg.storeName} />;
}
