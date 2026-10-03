import { asc } from "drizzle-orm";
import { categories, db } from "@/db";
import { requireOperator } from "@/lib/auth";
import { formatStoreDate } from "@/lib/loyalty";
import { listRewards } from "@/lib/loyalty-server";
import { getSettings } from "@/lib/orders";
import { deleteReward } from "../actions";
import { ConfirmButton } from "@/components/admin/confirm-button";
import { RewardForm } from "@/components/admin/reward-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function LoyaltyRewardsPage() {
  await requireOperator();
  const [store, rewards, cats] = await Promise.all([
    getSettings(),
    listRewards({ activeOnly: false }),
    db.select({ id: categories.id, name: categories.name }).from(categories).orderBy(asc(categories.sortOrder)),
  ]);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Customers pick one reward per order at checkout. Orders keep the reward&apos;s name, so editing or deleting
        one never changes past receipts.
      </p>

      {rewards.map((r) => (
        <Card key={r.id}>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              {r.name}
              {r.isActive ? null : <Badge variant="outline">Inactive</Badge>}
              {r.price.increase ? (
                <span className="text-xs font-normal text-muted-foreground">
                  Customers pay {r.price.cost.toLocaleString()} until{" "}
                  {formatStoreDate(r.price.increase.on, store.timezone)}
                </span>
              ) : null}
            </CardTitle>
            <form action={deleteReward}>
              <input type="hidden" name="id" value={r.id} />
              <ConfirmButton label="Delete" confirmLabel="Delete reward" size="xs" variant="ghost" />
            </form>
          </CardHeader>
          <CardContent>
            <RewardForm reward={r} categories={cats} submitLabel="Save" />
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Add a reward</CardTitle>
        </CardHeader>
        <CardContent>
          <RewardForm reward={null} categories={cats} submitLabel="Add reward" />
        </CardContent>
      </Card>
    </div>
  );
}
