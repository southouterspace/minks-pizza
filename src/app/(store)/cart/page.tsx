import type { Metadata } from "next";
import { CartView } from "@/components/store/cart-view";
import { getSettings } from "@/lib/orders";

export const metadata: Metadata = { title: "Cart" };
export const dynamic = "force-dynamic";

export default async function CartPage() {
  const settings = await getSettings();
  return <CartView orderType={settings.pickupEnabled ? "pickup" : "delivery"} />;
}
