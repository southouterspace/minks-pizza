import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Tag } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import { catalogNames, getMenuCatalog, listPromotions } from "@/lib/promotion-admin";
import { describePromotionShort } from "@/lib/promotion-copy";
import { promotionStatus } from "@/lib/promotion-engine";
import { PauseSwitch, PromotionStatusBadge } from "@/components/admin/promotion-controls";
import { buttonVariants } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Promotions" };

export default async function PromotionsPage() {
  await requireOperator();
  const [list, catalog] = await Promise.all([listPromotions(), getMenuCatalog()]);
  const names = catalogNames(catalog);
  const now = new Date();

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Promotions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Automatic deals and promo codes. Uses count orders that weren&apos;t canceled.
          </p>
        </div>
        <Link href="/admin/promotions/new" className={buttonVariants()}>
          <Plus data-icon="inline-start" />
          New deal
        </Link>
      </div>

      {list.length === 0 ? (
        <Empty className="mt-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Tag aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No deals yet</EmptyTitle>
            <EmptyDescription>Start from a template: percent off, BOGO, free delivery or a happy hour.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="mt-6 divide-y rounded-xl border" data-testid="promotions">
          {list.map(({ row, terms, codes, stats }) => {
            const status = promotionStatus(terms, stats, now);
            return (
              <li key={row.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3" data-testid={`promotion-${row.id}`}>
                <div className="min-w-0 flex-1 basis-64">
                  <p className="flex flex-wrap items-center gap-2">
                    <Link href={`/admin/promotions/${row.id}`} className="font-medium hover:underline">
                      {row.name}
                    </Link>
                    <PromotionStatusBadge status={status} />
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{describePromotionShort(terms, names)}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {row.trigger === "automatic"
                      ? "Automatic"
                      : [
                          codes.shared ? `Code ${codes.shared}` : null,
                          codes.singleUse ? `${codes.singleUse} single-use codes` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "Code (none added yet)"}
                  </p>
                </div>
                <dl className="grid grid-cols-3 gap-x-6 text-sm tabular-nums">
                  <div>
                    <dt className="text-xs text-muted-foreground">Uses</dt>
                    <dd data-testid="promo-uses">
                      {stats.uses}
                      {row.totalLimit ? ` / ${row.totalLimit}` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Discounted</dt>
                    <dd>{formatCents(stats.discountedCents)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Net sales</dt>
                    <dd>{formatCents(stats.netSalesCents)}</dd>
                  </div>
                </dl>
                {row.archivedAt ? null : <PauseSwitch id={row.id} active={row.isActive} name={row.name} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
