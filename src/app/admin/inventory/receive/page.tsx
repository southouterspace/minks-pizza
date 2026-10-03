import type { Metadata } from "next";
import Link from "next/link";
import { requireOperator } from "@/lib/auth";
import { stockLines } from "@/lib/inventory";
import { toEntry } from "@/app/admin/inventory/entry";
import { ReceiveForm } from "./receive-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Receive delivery" };

export default async function ReceivePage() {
  await requireOperator();
  const lines = await stockLines();

  return (
    <div>
      <Link href="/admin/inventory" className="text-sm text-muted-foreground hover:text-foreground">
        ← Inventory
      </Link>
      <h1 className="mt-2 text-xl font-semibold tracking-tight">Receive delivery</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        One line per item on the invoice, priced per the unit you enter. Each ingredient&apos;s cost
        becomes its latest delivered price.
      </p>
      <ReceiveForm ingredients={lines.map(toEntry)} />
    </div>
  );
}
