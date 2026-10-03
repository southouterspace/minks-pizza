import type { Metadata } from "next";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { Carrot, Plus } from "lucide-react";
import { db, ingredients } from "@/db";
import { requireOperator } from "@/lib/auth";
import { formatUnitCost } from "@/lib/unit-entry";
import { BASE_UNIT_LABEL, formatQty } from "@/lib/units";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Ingredients" };

const NOTICES: Record<string, string> = {
  saved: "Ingredient saved.",
  deleted: "Ingredient deleted.",
};

export default async function IngredientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();
  const params = await searchParams;
  const notice = Object.keys(NOTICES).find((k) => params[k] === "1");

  const rows = await db
    .select()
    .from(ingredients)
    .orderBy(asc(ingredients.storageArea), asc(ingredients.shelfOrder), asc(ingredients.name));
  const areas = [...new Set(rows.map((r) => r.storageArea))];

  return (
    <div>
      <p className="text-sm text-muted-foreground">
        <Link href="/admin/inventory" className="hover:text-foreground">
          Inventory
        </Link>{" "}
        /
      </p>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Ingredients</h1>
        <Link href="/admin/inventory/ingredients/new" className={buttonVariants({ size: "sm" })}>
          <Plus /> New ingredient
        </Link>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        What recipes are made of: what each costs, where it lives, and when it runs low.
      </p>
      {notice ? (
        <p role="status" className="mt-4 text-sm font-medium text-success">
          {NOTICES[notice]}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <Empty className="mt-6 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Carrot />
            </EmptyMedia>
            <EmptyTitle>No ingredients yet</EmptyTitle>
            <EmptyDescription>Add the cheese, sauce and toppings your recipes use.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      <div className="mt-6 space-y-6">
        {areas.map((area) => (
          <Card key={area} className="gap-0! py-0!">
            <CardHeader className="border-b pt-3 pb-3!">
              <CardTitle>
                <span className="text-sm font-semibold">{area}</span>
              </CardTitle>
            </CardHeader>
            <ul className="divide-y divide-border">
              {rows
                .filter((r) => r.storageArea === area)
                .map((r) => (
                  <li key={r.id} data-testid={`ingredient-${r.id}`}>
                    <Link
                      href={`/admin/inventory/ingredients/${r.id}`}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 transition-colors hover:bg-muted"
                    >
                      <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
                        <span className="truncate text-sm font-medium">{r.name}</span>
                        {r.isActive ? null : <Badge variant="secondary">Inactive</Badge>}
                      </span>
                      <span className="w-16 text-xs text-muted-foreground">
                        {BASE_UNIT_LABEL[r.baseUnit]}
                      </span>
                      <span className="w-24 text-sm tabular-nums">
                        {formatUnitCost(r.unitCostMillicents, r.baseUnit)}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums sm:w-44 sm:text-right">
                        {[
                          r.lowStockAtMilli !== null && `Low ${formatQty(r.lowStockAtMilli, r.baseUnit)}`,
                          r.outAtMilli !== null && `86 at ${formatQty(r.outAtMilli, r.baseUnit)}`,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "No thresholds"}
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}
