import type { Metadata } from "next";
import { getSettings } from "@/lib/orders";
import { ComingSoon } from "@/components/store/coming-soon";
import { CheckoutForm } from "@/components/store/checkout-form";

export const metadata: Metadata = { title: "Checkout" };
export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const settings = await getSettings();

  if (!settings.isPublished) {
    return (
      <ComingSoon
        name={settings.name}
        phone={settings.phone}
        logoUrl={settings.logoUrl}
      />
    );
  }

  return (
    <CheckoutForm
      config={{
        storeName: settings.name,
        storePhone: settings.phone,
        acceptingOrders: settings.isAcceptingOrders,
        pickupEnabled: settings.pickupEnabled,
        deliveryEnabled: settings.deliveryEnabled,
        pickupPrepMinutes: settings.pickupPrepMinutes,
        deliveryPrepMinutes: settings.deliveryPrepMinutes,
        deliveryFeeCents: settings.deliveryFeeCents,
        deliveryMinimumCents: settings.deliveryMinimumCents,
        taxRateBps: settings.taxRateBps,
      }}
    />
  );
}
