import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { requireOperator } from "@/lib/auth";
import { spotCountPreset, stockLines, type SpotRule } from "@/lib/inventory";
import { COUNT_KINDS } from "@/lib/inventory-domain";
import { toEntry } from "@/app/admin/inventory/entry";
import { CountSheet } from "./count-sheet";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Count" };

const SPOT_RULE: Record<SpotRule, string> = {
  usage: "The five ingredients with the most theoretical usage in dollars over the last 7 days.",
  value: "No sales in the last 7 days, so the five ingredients with the highest on-hand value.",
};

export default async function CountPage({ searchParams }: PageProps<"/admin/inventory/count">) {
  await requireOperator();
  const kind = z.enum(COUNT_KINDS).catch("full").parse((await searchParams).kind);
  const [lines, spot] = await Promise.all([
    stockLines(),
    kind === "spot" ? spotCountPreset() : null,
  ]);
  const picked = spot ? lines.filter((l) => spot.ids.includes(l.id)) : lines;

  return (
    <div>
      <Link href="/admin/inventory" className="text-sm text-muted-foreground hover:text-foreground">
        ← Inventory
      </Link>
      <h1 className="mt-2 text-xl font-semibold tracking-tight">
        {kind === "spot" ? "Spot count" : "Full count"}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="count-rule">
        {spot
          ? SPOT_RULE[spot.rule]
          : "Count everything on the shelves. Leave a line blank to skip it."}
      </p>
      <CountSheet kind={kind} ingredients={picked.map(toEntry)} />
    </div>
  );
}
