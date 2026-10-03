import type { Metadata } from "next";
import { CartView } from "@/components/store/cart-view";
import { getCurrentMember } from "@/lib/member-auth";
import { nextReward } from "@/lib/loyalty";
import { getLoyaltySettings, listRewards } from "@/lib/loyalty-server";

export const metadata: Metadata = { title: "Cart" };
export const dynamic = "force-dynamic";

export default async function CartPage() {
  const [loyalty, member] = await Promise.all([getLoyaltySettings(), getCurrentMember()]);
  if (!loyalty.enabled) return <CartView loyalty={null} />;

  const next = member
    ? nextReward(
        (await listRewards({ activeOnly: true })).map((r) => ({ name: r.name, cost: r.price.cost })),
        member.pointsBalance,
      )
    : null;
  return <CartView loyalty={{ balance: member?.pointsBalance ?? null, nextReward: next }} />;
}
