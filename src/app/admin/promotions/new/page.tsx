import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import { getSettings } from "@/lib/orders";
import { catalogNames, getMenuCatalog } from "@/lib/promotion-admin";
import { EMPTY_DRAFT } from "@/lib/promotion-draft";
import { PromotionForm } from "@/components/admin/promotion-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "New deal" };

export default async function NewPromotionPage() {
  await requireOperator();
  const [catalog, settings] = await Promise.all([getMenuCatalog(), getSettings()]);
  return (
    <div>
      <Link href="/admin/promotions" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        Promotions
      </Link>
      <h1 className="mt-2 mb-6 text-xl font-semibold tracking-tight">New deal</h1>
      <PromotionForm
        promotionId={null}
        initial={EMPTY_DRAFT}
        catalog={catalog}
        names={catalogNames(catalog)}
        timezone={settings.timezone}
      />
    </div>
  );
}
