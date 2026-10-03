import type { Metadata } from "next";
import { requireOperator } from "@/lib/auth";
import { LoyaltyTabs } from "@/components/admin/loyalty-tabs";

export const metadata: Metadata = { title: "Loyalty" };

export default async function LoyaltyLayout({ children }: LayoutProps<"/admin/loyalty">) {
  await requireOperator();
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Loyalty</h1>
      <div className="mt-4">
        <LoyaltyTabs />
      </div>
      <div className="mt-6">{children}</div>
    </div>
  );
}
