import type { Metadata, Viewport } from "next";
import { requireOperator } from "@/lib/auth";
import { getKdsSnapshot } from "@/lib/kds-server";
import { getStoreBasics } from "@/lib/settings-server";
import { KitchenDisplay } from "@/components/kitchen/kitchen-display";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Kitchen display" };

export const viewport: Viewport = { themeColor: "#09090b" };

export default async function KitchenPage() {
  await requireOperator();
  const [snapshot, store] = await Promise.all([getKdsSnapshot(), getStoreBasics()]);
  return <KitchenDisplay initial={snapshot} storeName={store.name} timeZone={store.timezone} />;
}
