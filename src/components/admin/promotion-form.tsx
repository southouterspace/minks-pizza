"use client";

import { useMemo, useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
import { savePromotion } from "@/app/admin/promotions/actions";
import type { MenuCatalog } from "@/lib/promotion-admin";
import { EMPTY_DRAFT, type PromotionDraft } from "@/lib/promotion-draft";
import {
  ANY_ITEM,
  describeOffer,
  describeTarget,
  promotionColumns,
  promotionInputSchema,
  type PromotionInput,
  type PromotionReward,
  type RewardType,
  type Target,
  type TargetNames,
  type WeeklyWindow,
} from "@/lib/promotions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const REWARD_LABEL: Record<RewardType, string> = {
  order_percent: "Percent off the order",
  order_amount: "Dollars off the order",
  item_percent: "Percent off items",
  item_amount: "Dollars off items",
  item_price: "Deal price on items",
  bogo: "Buy X, get Y",
  free_delivery: "Free delivery",
};

const cents = (s: string) => Math.round(Number.parseFloat(s || "0") * 100);
const intOrNull = (s: string) => (s.trim() === "" ? null : Number.parseInt(s, 10));
const bps = (s: string) => Math.round(Number.parseFloat(s || "0") * 100);
const centsOrNull = (s: string) => (s.trim() === "" ? null : cents(s));

function rewardOf(d: PromotionDraft): PromotionReward {
  switch (d.rewardType) {
    case "order_percent":
      return { type: "order_percent", percentBps: bps(d.percent), maxDiscountCents: centsOrNull(d.maxDiscount) };
    case "order_amount":
      return { type: "order_amount", amountCents: cents(d.amount) };
    case "item_percent":
      return { type: "item_percent", target: d.target, percentBps: bps(d.percent), maxUnits: intOrNull(d.maxUnits) };
    case "item_amount":
      return { type: "item_amount", target: d.target, amountCents: cents(d.amount), maxUnits: intOrNull(d.maxUnits) };
    case "item_price":
      return { type: "item_price", target: d.target, priceCents: cents(d.price), maxUnits: intOrNull(d.maxUnits) };
    case "bogo":
      return {
        type: "bogo",
        buy: { target: d.target, quantity: intOrNull(d.buyQty) ?? 0 },
        get: {
          target: d.getSameAsBuy ? d.target : d.getTarget,
          quantity: intOrNull(d.getQty) ?? 0,
          percentBps: bps(d.getPercent),
        },
        maxApplications: intOrNull(d.maxApplications),
      };
    case "free_delivery":
      return { type: "free_delivery" };
  }
}

function toInput(d: PromotionDraft): PromotionInput {
  return {
    name: d.name,
    description: d.description.trim() || null,
    trigger: d.trigger,
    reward: rewardOf(d),
    minSubtotalCents: cents(d.minSubtotal),
    orderTypes: [...(d.pickup ? (["pickup"] as const) : []), ...(d.delivery ? (["delivery"] as const) : [])],
    startsOn: d.startsOn || null,
    endsOn: d.endsOn || null,
    schedule: d.schedule,
    newCustomersOnly: d.newCustomersOnly,
    perCustomerLimit: intOrNull(d.perCustomerLimit),
    totalLimit: intOrNull(d.totalLimit),
    stackable: d.stackable,
    advertised: d.advertised,
  };
}

function templates(catalog: MenuCatalog): { label: string; draft: Partial<PromotionDraft> }[] {
  const large = catalog.modifierGroups.flatMap((g) => g.modifiers).find((m) => /large/i.test(m.name) && !/x-?large/i.test(m.name));
  const larges: Target = { ...ANY_ITEM, modifierIds: large ? [large.id] : [] };
  return [
    { label: "Percent off order", draft: { name: "10% off your order", trigger: "code", rewardType: "order_percent", percent: "10" } },
    { label: "$ off order", draft: { name: "$5 off orders $25+", trigger: "code", rewardType: "order_amount", amount: "5", minSubtotal: "25" } },
    {
      label: "BOGO",
      draft: { name: "Buy one large, get one free", trigger: "automatic", rewardType: "bogo", target: larges, buyQty: "1", getQty: "1", getSameAsBuy: true, getPercent: "100" },
    },
    { label: "Item deal price", draft: { name: "Any large pizza $12", trigger: "automatic", rewardType: "item_price", target: larges, price: "12" } },
    {
      label: "Free delivery",
      draft: { name: "Free delivery on $30+", trigger: "automatic", rewardType: "free_delivery", minSubtotal: "30", pickup: false, delivery: true },
    },
    {
      label: "Happy hour",
      draft: {
        name: "Happy hour: 20% off",
        trigger: "automatic",
        rewardType: "order_percent",
        percent: "20",
        schedule: [{ days: [1, 2, 3, 4, 5], start: "15:00", end: "17:00" }],
      },
    },
  ];
}

export function PromotionForm({
  promotionId,
  initial,
  catalog,
  names,
  timezone,
}: {
  promotionId: number | null;
  initial: PromotionDraft;
  catalog: MenuCatalog;
  names: TargetNames;
  timezone: string;
}) {
  const [draft, setDraft] = useState<PromotionDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof PromotionDraft>(key: K, value: PromotionDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const parsed = useMemo(() => promotionInputSchema.safeParse(toInput(draft)), [draft]);
  const preview = parsed.success
    ? describeOffer(
        { ...parsed.data, ...promotionColumns(parsed.data, timezone) },
        { timezone, code: draft.trigger === "code" ? draft.code.trim().toUpperCase() || null : null, names },
      )
    : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the form.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await savePromotion(promotionId, parsed.data, promotionId === null ? draft.code : undefined);
      if (result?.error) setError(result.error);
    });
  };

  const r = draft.rewardType;
  const hasTarget = r === "item_percent" || r === "item_amount" || r === "item_price" || r === "bogo";

  return (
    <form onSubmit={submit} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-4">
        {promotionId === null ? (
          <Card size="sm">
            <CardHeader>
              <CardTitle>Start from a template</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {templates(catalog).map((t) => (
                <Button
                  key={t.label}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDraft({ ...EMPTY_DRAFT, ...t.draft })}
                >
                  {t.label}
                </Button>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <Card size="sm">
          <CardHeader>
            <CardTitle>Deal</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="promo-name">Name customers see</FieldLabel>
                <Input id="promo-name" value={draft.name} onChange={(e) => set("name", e.target.value)} maxLength={80} placeholder="Tuesday 2-for-1 Larges" />
              </Field>
              <Field>
                <FieldLabel htmlFor="promo-description">Terms (optional)</FieldLabel>
                <Textarea
                  id="promo-description"
                  value={draft.description}
                  onChange={(e) => set("description", e.target.value)}
                  rows={2}
                  maxLength={500}
                  placeholder="Leave blank to use the summary on the right"
                />
              </Field>
              <Field>
                <FieldLabel>How customers get it</FieldLabel>
                <Segmented
                  value={draft.trigger}
                  options={[
                    ["automatic", "Automatically"],
                    ["code", "With a code"],
                  ]}
                  onChange={(v) => set("trigger", v)}
                />
              </Field>
              {draft.trigger === "code" && promotionId === null ? (
                <Field>
                  <FieldLabel htmlFor="promo-code">Code</FieldLabel>
                  <Input
                    id="promo-code"
                    value={draft.code}
                    onChange={(e) => set("code", e.target.value)}
                    className="font-mono uppercase"
                    maxLength={30}
                    placeholder="PIZZA10"
                  />
                  <FieldDescription>Optional now. You can add more codes or generate single-use ones after saving.</FieldDescription>
                </Field>
              ) : null}
            </FieldGroup>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Reward</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="promo-reward">Type</FieldLabel>
                <NativeSelect
                  id="promo-reward"
                  value={r}
                  onChange={(e) => set("rewardType", e.target.value as RewardType)}
                  className="w-full"
                >
                  {(Object.keys(REWARD_LABEL) as RewardType[]).map((t) => (
                    <NativeSelectOption key={t} value={t}>
                      {REWARD_LABEL[t]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                {r === "order_percent" || r === "item_percent" ? (
                  <NumberField id="promo-percent" label="Percent off" suffix="%" value={draft.percent} onChange={(v) => set("percent", v)} />
                ) : null}
                {r === "order_percent" ? (
                  <NumberField id="promo-max" label="Up to (optional)" prefix="$" value={draft.maxDiscount} onChange={(v) => set("maxDiscount", v)} />
                ) : null}
                {r === "order_amount" || r === "item_amount" ? (
                  <NumberField id="promo-amount" label="Amount off" prefix="$" value={draft.amount} onChange={(v) => set("amount", v)} />
                ) : null}
                {r === "item_price" ? (
                  <NumberField id="promo-price" label="Deal price each" prefix="$" value={draft.price} onChange={(v) => set("price", v)} />
                ) : null}
                {r === "item_percent" || r === "item_amount" || r === "item_price" ? (
                  <NumberField id="promo-units" label="Max items per order (optional)" value={draft.maxUnits} onChange={(v) => set("maxUnits", v)} step="1" />
                ) : null}
                {r === "bogo" ? (
                  <>
                    <NumberField id="promo-buy" label="Buy" value={draft.buyQty} onChange={(v) => set("buyQty", v)} step="1" />
                    <NumberField id="promo-get" label="Get" value={draft.getQty} onChange={(v) => set("getQty", v)} step="1" />
                    <NumberField id="promo-get-percent" label="Off the cheapest (100 = free)" suffix="%" value={draft.getPercent} onChange={(v) => set("getPercent", v)} />
                    <NumberField id="promo-apps" label="Max times per order (optional)" value={draft.maxApplications} onChange={(v) => set("maxApplications", v)} step="1" />
                  </>
                ) : null}
              </div>
              {hasTarget ? (
                <TargetPicker
                  label={r === "bogo" ? "Buy items" : "Which items"}
                  catalog={catalog}
                  names={names}
                  value={draft.target}
                  onChange={(t) => set("target", t)}
                />
              ) : null}
              {r === "bogo" ? (
                <>
                  <CheckField id="promo-same" label="Get the same kind of item" checked={draft.getSameAsBuy} onChange={(v) => set("getSameAsBuy", v)} />
                  {!draft.getSameAsBuy ? (
                    <TargetPicker label="Get items" catalog={catalog} names={names} value={draft.getTarget} onChange={(t) => set("getTarget", t)} />
                  ) : null}
                </>
              ) : null}
            </FieldGroup>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>When it applies</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <NumberField id="promo-min" label="Minimum item subtotal (optional)" prefix="$" value={draft.minSubtotal} onChange={(v) => set("minSubtotal", v)} />
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                <CheckField id="promo-pickup" label="Pickup" checked={draft.pickup} onChange={(v) => set("pickup", v)} />
                <CheckField id="promo-delivery" label="Delivery" checked={draft.delivery} onChange={(v) => set("delivery", v)} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="promo-starts">Starts on (optional)</FieldLabel>
                  <Input id="promo-starts" type="date" value={draft.startsOn} onChange={(e) => set("startsOn", e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="promo-ends">Last day (optional)</FieldLabel>
                  <Input id="promo-ends" type="date" value={draft.endsOn} onChange={(e) => set("endsOn", e.target.value)} />
                </Field>
              </div>
              <ScheduleEditor value={draft.schedule} onChange={(s) => set("schedule", s)} />
            </FieldGroup>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Limits and visibility</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField id="promo-per-customer" label="Uses per customer (optional)" value={draft.perCustomerLimit} onChange={(v) => set("perCustomerLimit", v)} step="1" />
                <NumberField id="promo-total" label="Total uses (optional)" value={draft.totalLimit} onChange={(v) => set("totalLimit", v)} step="1" />
              </div>
              <CheckField id="promo-new" label="New customers only (first order on this phone number)" checked={draft.newCustomersOnly} onChange={(v) => set("newCustomersOnly", v)} />
              <CheckField id="promo-stack" label="Combines with other combinable deals" checked={draft.stackable} onChange={(v) => set("stackable", v)} />
              <CheckField
                id="promo-advertised"
                label="Show on the menu page (off = private code for a mailer or partner)"
                checked={draft.advertised}
                onChange={(v) => set("advertised", v)}
              />
            </FieldGroup>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3 lg:sticky lg:top-6 lg:self-start">
        <Card size="sm">
          <CardHeader>
            <CardTitle>What customers see</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="font-semibold">{draft.name || "Untitled deal"}</p>
            <p className="text-muted-foreground" data-testid="promo-preview">
              {draft.description.trim() || preview || "Finish the form to see the summary."}
            </p>
            {!parsed.success ? (
              <p className="text-xs text-warning">{parsed.error.issues[0]?.message}</p>
            ) : null}
          </CardContent>
        </Card>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending} className="w-full" data-testid="save-promotion">
          {pending ? "Saving…" : promotionId === null ? "Create deal" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map(([v, label]) => (
        <Button
          key={v}
          type="button"
          variant="outline"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn(value === v && "border-foreground! bg-muted!")}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  prefix,
  suffix,
  step = "0.01",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  suffix?: string;
  step?: string;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative">
        {prefix ? (
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">{prefix}</span>
        ) : null}
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min="0"
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(prefix && "pl-7!", suffix && "pr-8!")}
        />
        {suffix ? (
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-foreground">{suffix}</span>
        ) : null}
      </div>
    </Field>
  );
}

function CheckField({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Field orientation="horizontal">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <FieldLabel htmlFor={id} className="font-normal">
        {label}
      </FieldLabel>
    </Field>
  );
}

function toggle(ids: number[], id: number): number[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

function Chip({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <Button type="button" size="sm" variant={on ? "default" : "outline"} aria-pressed={on} onClick={onClick} className="h-7! px-2.5! text-xs">
      {children}
    </Button>
  );
}

/** Category, item and size (any modifier) filters; nothing picked means any item. */
function TargetPicker({
  label,
  catalog,
  names,
  value,
  onChange,
}: {
  label: string;
  catalog: MenuCatalog;
  names: TargetNames;
  value: Target;
  onChange: (t: Target) => void;
}) {
  const summary = describeTarget(value, names);
  return (
    <details className="rounded-lg border p-3" open>
      <summary className="cursor-pointer text-sm font-medium">
        {label}: <span className="font-normal text-muted-foreground">{summary === "item" ? "any item" : summary}</span>
      </summary>
      <div className="mt-3 space-y-3">
        <ChipGroup title="Categories">
          {catalog.categories.map((c) => (
            <Chip key={c.id} on={value.categoryIds.includes(c.id)} onClick={() => onChange({ ...value, categoryIds: toggle(value.categoryIds, c.id) })}>
              {c.name}
            </Chip>
          ))}
        </ChipGroup>
        <ChipGroup title="Items">
          {catalog.items
            .filter((i) => value.categoryIds.length === 0 || value.categoryIds.includes(i.categoryId))
            .map((i) => (
              <Chip key={i.id} on={value.itemIds.includes(i.id)} onClick={() => onChange({ ...value, itemIds: toggle(value.itemIds, i.id) })}>
                {i.name}
              </Chip>
            ))}
        </ChipGroup>
        {catalog.modifierGroups
          .filter((g) => g.modifiers.length > 0)
          .map((g) => (
            <ChipGroup key={g.id} title={`${g.name} (must include one)`}>
              {g.modifiers.map((m) => (
                <Chip key={m.id} on={value.modifierIds.includes(m.id)} onClick={() => onChange({ ...value, modifierIds: toggle(value.modifierIds, m.id) })}>
                  {m.name}
                </Chip>
              ))}
            </ChipGroup>
          ))}
      </div>
    </details>
  );
}

function ChipGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Weekly time windows on the store's clock; none means any time. */
function ScheduleEditor({ value, onChange }: { value: WeeklyWindow[]; onChange: (s: WeeklyWindow[]) => void }) {
  const update = (i: number, w: WeeklyWindow) => onChange(value.map((x, j) => (j === i ? w : x)));
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        Days and times <span className="font-normal text-muted-foreground">({value.length ? "only during these windows" : "any time"})</span>
      </p>
      {value.map((w, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border p-2" data-testid="schedule-window">
          <div className="flex gap-1">
            {DAY_LETTERS.map((letter, d) => (
              <Button
                key={d}
                type="button"
                size="icon-sm"
                variant={w.days.includes(d) ? "default" : "outline"}
                aria-pressed={w.days.includes(d)}
                aria-label={DAY_FULL[d]}
                onClick={() => update(i, { ...w, days: toggle(w.days, d).sort((a, b) => a - b) })}
              >
                {letter}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <Input type="time" aria-label="Start time" value={w.start} onChange={(e) => update(i, { ...w, start: e.target.value })} className="w-28" />
            <span className="text-muted-foreground">to</span>
            <Input type="time" aria-label="End time" value={w.end} onChange={(e) => update(i, { ...w, end: e.target.value })} className="w-28" />
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove time window" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <X />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...value, { days: [1, 2, 3, 4, 5], start: "15:00", end: "18:00" }])}
      >
        <Plus data-icon="inline-start" />
        Add time window
      </Button>
    </div>
  );
}
