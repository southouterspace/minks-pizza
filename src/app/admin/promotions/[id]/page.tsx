import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import { zonedParts } from "@/lib/hours";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/orders";
import { catalogNames, everUsed, getMenuCatalog, getPromotion } from "@/lib/promotion-admin";
import { promotionStatus, type PromotionTerms } from "@/lib/promotions";
import { EMPTY_DRAFT, PromotionForm, type PromotionDraft } from "@/components/admin/promotion-form";
import {
  ArchiveButtons,
  CodesPanel,
  PauseSwitch,
  PromotionStatusBadge,
} from "@/components/admin/promotion-controls";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Deal" };

const dollars = (c: number) => (c / 100).toFixed(2).replace(/\.00$/, "");
const optional = (n: number | null) => (n === null ? "" : String(n));

/** The stored deal back into the form's strings; days on the store's calendar. */
function toDraft(p: PromotionTerms & { description: string | null; advertised: boolean }, tz: string): PromotionDraft {
  const r = p.reward;
  const d: PromotionDraft = {
    ...EMPTY_DRAFT,
    name: p.name,
    description: p.description ?? "",
    trigger: p.trigger,
    rewardType: r.type,
    minSubtotal: p.minSubtotalCents ? dollars(p.minSubtotalCents) : "",
    pickup: p.orderTypes.includes("pickup"),
    delivery: p.orderTypes.includes("delivery"),
    startsOn: p.startsAt ? zonedParts(p.startsAt, tz).date : "",
    endsOn: p.endsAt ? zonedParts(new Date(p.endsAt.getTime() - 1), tz).date : "",
    schedule: p.schedule ?? [],
    newCustomersOnly: p.newCustomersOnly,
    perCustomerLimit: optional(p.perCustomerLimit),
    totalLimit: optional(p.totalLimit),
    stackable: p.stackable,
    advertised: p.advertised,
  };
  switch (r.type) {
    case "order_percent":
      return { ...d, percent: String(r.percentBps / 100), maxDiscount: r.maxDiscountCents ? dollars(r.maxDiscountCents) : "" };
    case "order_amount":
      return { ...d, amount: dollars(r.amountCents) };
    case "item_percent":
      return { ...d, target: r.target, percent: String(r.percentBps / 100), maxUnits: optional(r.maxUnits) };
    case "item_amount":
      return { ...d, target: r.target, amount: dollars(r.amountCents), maxUnits: optional(r.maxUnits) };
    case "item_price":
      return { ...d, target: r.target, price: dollars(r.priceCents), maxUnits: optional(r.maxUnits) };
    case "bogo":
      return {
        ...d,
        target: r.buy.target,
        buyQty: String(r.buy.quantity),
        getQty: String(r.get.quantity),
        getSameAsBuy: JSON.stringify(r.buy.target) === JSON.stringify(r.get.target),
        getTarget: r.get.target,
        getPercent: String(r.get.percentBps / 100),
        maxApplications: optional(r.maxApplications),
      };
    case "free_delivery":
      return d;
  }
}

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
