import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import { LEDGER_KIND_RULES, formatMultiplier, formatPhone } from "@/lib/loyalty";
import { getLoyaltySettings, getMember, memberLedger, memberStatus } from "@/lib/loyalty-server";
import { addMissingOrder, adjustPoints, saveMemberBirthday } from "../../actions";
import { FormNotice } from "@/components/admin/form-notice";
import { formatDateTime } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const SAVED: Record<string, string> = {
  adjusted: "Points adjusted.",
  claimed: "Order added and its points posted.",
  birthday: "Birthday saved.",
};

export default async function LoyaltyMemberPage({ params, searchParams }: PageProps<"/admin/loyalty/members/[id]">) {
  await requireOperator();
  const id = Number.parseInt((await params).id, 10);
  const member = Number.isInteger(id) ? await getMember(id) : null;
  if (!member) notFound();
  const sp = await searchParams;
  const [settings, ledger] = await Promise.all([getLoyaltySettings(), memberLedger(member.id, 200)]);
  const status = await memberStatus(member, settings);

  return (
    <div className="space-y-6">
      <Link href="/admin/loyalty/members" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> Members
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{member.name ?? "No name"}</h2>
          <p className="text-sm text-muted-foreground">
            {formatPhone(member.phone)} · joined {formatDateTime(member.createdAt)} ·{" "}
            {member.verifiedAt ? "verified by text" : "not verified yet"}
          </p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-semibold tabular-nums" data-testid="member-balance">
            {member.pointsBalance.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground">
            points · {status.tier.name} ({formatMultiplier(status.tier.multiplierBps)}) ·{" "}
            {member.lifetimePoints.toLocaleString()} lifetime
          </p>
        </div>
      </div>

      <FormNotice saved={SAVED[String(sp.saved ?? "")]} error={typeof sp.error === "string" ? sp.error : null} />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Adjust points</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={adjustPoints} className="space-y-3">
              <input type="hidden" name="memberId" value={member.id} />
              <Field>
                <FieldLabel htmlFor="adj-points">Points (use − to remove)</FieldLabel>
                <Input id="adj-points" name="points" type="number" step="1" required placeholder="50 or -50" />
              </Field>
              <Field>
                <FieldLabel htmlFor="adj-reason">Reason</FieldLabel>
                <Input id="adj-reason" name="reason" required maxLength={200} placeholder="Late delivery" />
              </Field>
              <Button type="submit" className="h-9!">Adjust points</Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Birthday</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={saveMemberBirthday} className="space-y-3">
              <input type="hidden" name="memberId" value={member.id} />
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="bd-month">Month</FieldLabel>
                  <Input id="bd-month" name="month" type="number" min={1} max={12} required defaultValue={member.birthMonth ?? ""} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="bd-day">Day</FieldLabel>
                  <Input id="bd-day" name="day" type="number" min={1} max={31} required defaultValue={member.birthDay ?? ""} />
                </Field>
              </div>
              <Button type="submit" variant="outline" className="h-9!">Save birthday</Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Add a missing order</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={addMissingOrder} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="memberId" value={member.id} />
            <Field className="w-40!">
              <FieldLabel htmlFor="claim-order">Order number</FieldLabel>
              <Input id="claim-order" name="orderNumber" inputMode="numeric" required placeholder="1042" />
            </Field>
            <Button type="submit" variant="outline" className="h-9!">Add order</Button>
            <p className="basis-full text-xs text-muted-foreground">
              For a completed order placed without their phone or before they joined. It earns at the base rate.
            </p>
          </form>
        </CardContent>
      </Card>

      <section>
        <h3 className="text-sm font-semibold">History</h3>
        {ledger.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No points activity yet.</p>
        ) : (
          <Card className="mt-3 gap-0! py-0!" data-testid="member-ledger">
            {ledger.map((e, i) => (
              <div
                key={e.id}
                className={cn("flex items-center justify-between gap-4 px-5 py-3 text-sm", i > 0 && "border-t border-border")}
              >
                <span className="min-w-0">
                  <span className="block">
                    {LEDGER_KIND_RULES[e.kind].label}
                    {e.note ? <span className="text-muted-foreground"> · {e.note}</span> : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {formatDateTime(e.createdAt)}
                    {e.orderNumber ? ` · Order #${e.orderNumber}` : ""}
                  </span>
                </span>
                <span className={cn("shrink-0 font-medium tabular-nums", e.points > 0 ? "text-success" : "text-muted-foreground")}>
                  {e.points > 0 ? "+" : "−"}
                  {Math.abs(e.points).toLocaleString()}
                </span>
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}
