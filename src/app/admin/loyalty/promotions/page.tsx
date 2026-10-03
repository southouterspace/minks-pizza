import { requireOperator } from "@/lib/auth";
import { DAY_NAMES } from "@/lib/zoned";
import { activePromotion, formatMultiplier } from "@/lib/loyalty";
import { getLoyaltySettings, listPromotions } from "@/lib/loyalty-server";
import { deletePromotion, savePromotion } from "../actions";
import { ConfirmButton } from "@/components/admin/confirm-button";
import { FormNotice } from "@/components/admin/form-notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export const dynamic = "force-dynamic";

const MULTIPLIERS = [12_500, 15_000, 20_000, 30_000];

type Promo = Awaited<ReturnType<typeof listPromotions>>[number];

function PromotionForm({ promo }: { promo: Promo | null }) {
  const prefix = promo ? `p${promo.id}` : "new";
  return (
    <form action={savePromotion} className="space-y-4" data-testid={promo ? `promo-form-${promo.id}` : "promo-form-new"}>
      {promo ? <input type="hidden" name="id" value={promo.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <Field>
          <FieldLabel htmlFor={`${prefix}-name`}>Name</FieldLabel>
          <Input id={`${prefix}-name`} name="name" required maxLength={80} defaultValue={promo?.name} placeholder="Double points Tuesdays" />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${prefix}-mult`}>Points</FieldLabel>
          <NativeSelect id={`${prefix}-mult`} name="multiplier" defaultValue={String((promo?.multiplierBps ?? 20_000) / 10_000)} className="w-full">
            {MULTIPLIERS.map((bps) => (
              <NativeSelectOption key={bps} value={String(bps / 10_000)}>
                {formatMultiplier(bps)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <fieldset>
        <legend className="text-sm font-medium">
          Days <span className="font-normal text-muted-foreground">(none checked = every day)</span>
        </legend>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {DAY_NAMES.map((day, i) => (
            <label key={day} className="flex items-center gap-2 text-sm">
              <Checkbox name="daysOfWeek" value={String(i)} defaultChecked={promo?.daysOfWeek.includes(i)} />
              {day.slice(0, 3)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${prefix}-start`}>Starts <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
          <Input id={`${prefix}-start`} name="startsOn" type="date" defaultValue={promo?.startsOn ?? ""} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${prefix}-end`}>Ends <span className="font-normal text-muted-foreground">(optional, inclusive)</span></FieldLabel>
          <Input id={`${prefix}-end`} name="endsOn" type="date" defaultValue={promo?.endsOn ?? ""} />
        </Field>
      </div>
      <div className="flex items-center gap-5">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="isActive" defaultChecked={promo?.isActive ?? true} />
          Active
        </label>
        <Button type="submit" className="ml-auto h-9!">{promo ? "Save" : "Add promotion"}</Button>
      </div>
    </form>
  );
}

export default async function LoyaltyPromotionsPage({ searchParams }: PageProps<"/admin/loyalty/promotions">) {
  await requireOperator();
  const sp = await searchParams;
  const [settings, promos] = await Promise.all([getLoyaltySettings(), listPromotions()]);
  const running = activePromotion(promos, new Date(), settings.timezone);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Promotions multiply the points an order earns on the days they run, in the store&apos;s timezone (
        {settings.timezone}). When two overlap, the bigger one wins.
      </p>
      <FormNotice saved={sp.saved ? "Promotion saved." : null} error={typeof sp.error === "string" ? sp.error : null} />

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
