import type { Metadata } from "next";
import { getSettings } from "@/lib/orders";
import { formatPhone } from "@/lib/loyalty";
import { getLoyaltySettings } from "@/lib/loyalty-server";
import { getRefreshedCurrentMember } from "@/lib/member-auth";
import { ComingSoon } from "@/components/store/coming-soon";
import { CheckoutForm } from "@/components/store/checkout-form";

export const metadata: Metadata = { title: "Checkout" };
export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const [settings, loyalty, member] = await Promise.all([
    getSettings(),
    getLoyaltySettings(),
    getRefreshedCurrentMember(),
  ]);

  if (!settings.isPublished) {
    return (
      <ComingSoon
        name={settings.name}
        phone={settings.phone}
        logoUrl={settings.logoUrl}
        logoUploadedAt={settings.logoUploadedAt}
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
        loyalty: loyalty.enabled
          ? {
              programName: loyalty.programName,
              member: member
                ? {
                    name: member.name,
                    phone: formatPhone(member.phone),
                    pointsBalance: member.pointsBalance,
                  }
                : null,
            }
          : null,
      }}
    />
  );
}
