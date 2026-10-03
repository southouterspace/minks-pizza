import type { Metadata } from "next";
import { CartView } from "@/components/store/cart-view";
import { getCurrentMember } from "@/lib/member-auth";
import { getLoyaltySettings, listRewards } from "@/lib/loyalty-server";

export const metadata: Metadata = { title: "Cart" };
export const dynamic = "force-dynamic";

export default async function CartPage() {
  const [loyalty, member] = await Promise.all([getLoyaltySettings(), getCurrentMember()]);
  if (!loyalty.enabled) return <CartView loyalty={null} />;

  const next = member
    ? (await listRewards({ activeOnly: true }))
        .filter((r) => r.price.cost > member.pointsBalance)
        .toSorted((a, b) => a.price.cost - b.price.cost)[0]
    : undefined;
  return (
    <CartView
      loyalty={{
        balance: member?.pointsBalance ?? null,
        nextReward: next ? { name: next.name, cost: next.price.cost } : null,
      }}
    />
  );
}
