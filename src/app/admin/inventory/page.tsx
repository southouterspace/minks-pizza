import type { Metadata } from "next";
import { requireOperator } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Inventory" };

export default async function InventoryPage() {
  await requireOperator();
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Inventory</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Ingredients, counts, waste and receiving are on the way.
      </p>
    </div>
  );
}
