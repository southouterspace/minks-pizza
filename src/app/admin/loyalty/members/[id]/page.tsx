import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import { LEDGER_KIND_RULES, formatMultiplier, formatPhone, formatPointsDelta } from "@/lib/loyalty";
import { getLoyaltySettings, getMember, memberLedger, memberStatus } from "@/lib/loyalty-server";
import { restoreExpired } from "../../actions";
import { AdjustPointsForm, MemberBirthdayForms, MissingOrderForm } from "@/components/admin/member-forms";
import { formatDateTime } from "@/components/admin/ui";
import { getSettings } from "@/lib/settings-server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";


export default async function LoyaltyMemberPage({ params }: PageProps<"/admin/loyalty/members/[id]">) {
  await requireOperator();
  const id = Number.parseInt((await params).id, 10);
  const member = Number.isInteger(id) ? await getMember(id) : null;
  if (!member) notFound();
  const [settings, store, ledger] = await Promise.all([getLoyaltySettings(), getSettings(), memberLedger(member.id, 200)]);
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
            {formatPhone(member.phone)} · joined {formatDateTime(member.createdAt, store.timezone)} ·{" "}
            {member.verifiedAt ? "verified by text" : "not verified yet"}
          </p>
        </div>
        <div className="sm:text-right">
          <p className="text-3xl font-semibold tabular-nums" data-testid="member-balance">
            {member.pointsBalance.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground">
            points ·{" "}
            {settings.tiers.length > 1
              ? `${status.tier.name} (${formatMultiplier(status.tier.multiplierBps)}) · `
              : ""}
            {member.lifetimePoints.toLocaleString()} lifetime
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Adjust points</CardTitle>
          </CardHeader>
          <CardContent>
            <AdjustPointsForm memberId={member.id} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Birthday</CardTitle>
          </CardHeader>
          <CardContent>
            <MemberBirthdayForms
              memberId={member.id}
              birthMonth={member.birthMonth}
              birthDay={member.birthDay}
              birthdayPoints={settings.birthdayPoints}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Add a missing order</CardTitle>
        </CardHeader>
        <CardContent>
          <MissingOrderForm memberId={member.id} />
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
                    {formatDateTime(e.createdAt, store.timezone)}
                    {e.orderNumber ? ` · Order #${e.orderNumber}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {e.restorable ? (
                    <form action={restoreExpired}>
                      <input type="hidden" name="entryId" value={e.id} />
                      <input type="hidden" name="memberId" value={member.id} />
                      <Button type="submit" variant="outline" size="xs">Restore</Button>
                    </form>
                  ) : null}
                  <span className={cn("font-medium tabular-nums", e.points > 0 ? "text-success" : "text-muted-foreground")}>
                    {formatPointsDelta(e.points)}
                  </span>
                </span>
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}
