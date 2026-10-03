import type { Metadata } from "next";
import { requireOperator } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage() {
  await requireOperator();
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Usage, variance and margin reports are on the way.
      </p>
    </div>
  );
}
