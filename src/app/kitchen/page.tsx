import type { Metadata, Viewport } from "next";
import { eq } from "drizzle-orm";
import { db, storeSettings } from "@/db";
import { requireOperator } from "@/lib/auth";
import { getKdsSnapshot } from "@/lib/kds-server";
import { KitchenDisplay } from "@/components/kitchen/kitchen-display";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Kitchen display" };

export const viewport: Viewport = { themeColor: "#09090b" };

export default async function KitchenPage() {
  await requireOperator();
  const [snapshot, [settings]] = await Promise.all([
    getKdsSnapshot(),
    db.select({ name: storeSettings.name }).from(storeSettings).where(eq(storeSettings.id, 1)),
  ]);
  return <KitchenDisplay initial={snapshot} storeName={settings?.name ?? "Mink's Pizza"} />;
}
