import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings-server";
import { catalogNames, everUsed, getMenuCatalog, getPromotion } from "@/lib/promotion-admin";
import { toDraft } from "@/lib/promotion-codec";
import { promotionStatus } from "@/lib/promotion-engine";
import { PromotionForm } from "@/components/admin/promotion-form";
import {
  ArchiveButtons,
  CodesPanel,
  PauseSwitch,
  PromotionStatusBadge,
} from "@/components/admin/promotion-controls";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Deal" };

export default async function PromotionPage({ params, searchParams }: PageProps<"/admin/promotions/[id]">) {
  await requireOperator();
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const [promo, catalog, settings] = await Promise.all([getPromotion(id), getMenuCatalog(), getSettings()]);
  if (!promo) notFound();
  const used = await everUsed(id);
  const { row, terms, stats } = promo;
  const status = promotionStatus(terms, stats, new Date());
  const saved = (await searchParams).saved === "1";

  return (
    <div>
      <Link href="/admin/promotions" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        Promotions
      </Link>
      <div className="mt-2 mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
          {row.name}
          <PromotionStatusBadge status={status} />
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          {row.archivedAt ? null : (
            <label className="flex items-center gap-2 text-sm">
              <PauseSwitch id={row.id} active={row.isActive} name={row.name} />
              {row.isActive ? "Running" : "Paused"}
            </label>
          )}
          <ArchiveButtons id={row.id} archived={Boolean(row.archivedAt)} used={used} />
        </div>
      </div>

      {saved ? (
        <p role="status" className="mb-4 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
          Saved. Orders already placed keep the discount they got.
        </p>
      ) : null}

      <dl className="mb-6 grid grid-cols-3 gap-3 text-sm sm:max-w-lg">
        {(
          [
            ["Uses", `${stats.uses}${row.totalLimit ? ` / ${row.totalLimit}` : ""}`],
            ["Discounted", formatCents(stats.discountedCents)],
            ["Net sales", formatCents(stats.netSalesCents)],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded-lg border px-3 py-2">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {row.trigger === "code" ? (
        <Card size="sm" className="mb-4">
          <CardHeader>
            <CardTitle>Codes</CardTitle>
          </CardHeader>
          <CardContent>
            <CodesPanel promotionId={row.id} codes={promo.codes} totalCodes={promo.totalCodes} />
          </CardContent>
        </Card>
      ) : null}

      <PromotionForm
        key={row.updatedAt.toISOString()}
        promotionId={row.id}
        initial={toDraft({ ...terms, description: row.description, advertised: row.advertised }, settings.timezone)}
        catalog={catalog}
        names={catalogNames(catalog)}
        timezone={settings.timezone}
      />
    </div>
  );
}
