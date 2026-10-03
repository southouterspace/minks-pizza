import { requireOperator } from "@/lib/auth";
import { activePromotion } from "@/lib/loyalty";
import { listPromotions } from "@/lib/loyalty-server";
import { getSettings } from "@/lib/orders";
import { deletePromotion } from "../actions";
import { PromotionForm } from "@/components/admin/promotion-form";
import { ConfirmButton } from "@/components/admin/confirm-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function LoyaltyPromotionsPage() {
  await requireOperator();
  const [settings, promos] = await Promise.all([getSettings(), listPromotions()]);
  const running = activePromotion(promos, new Date(), settings.timezone);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Promotions multiply the points an order earns on the days they run, in the store&apos;s timezone (
        {settings.timezone}). When two overlap, the bigger one wins.
      </p>

      {promos.map((p) => (
        <Card key={p.id}>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              {p.name}
              {running?.id === p.id ? <Badge>Running today</Badge> : null}
              {p.isActive ? null : <Badge variant="outline">Inactive</Badge>}
            </CardTitle>
            <form action={deletePromotion}>
              <input type="hidden" name="id" value={p.id} />
              <ConfirmButton label="Delete" confirmLabel="Delete promotion" size="xs" variant="ghost" />
            </form>
          </CardHeader>
          <CardContent>
            <PromotionForm promo={p} />
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Add a promotion</CardTitle>
        </CardHeader>
        <CardContent>
          <PromotionForm promo={null} />
        </CardContent>
      </Card>
    </div>
  );
}
