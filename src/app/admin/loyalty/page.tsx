import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import { centsPerPoint } from "@/lib/loyalty";
import { getLoyaltySettings, listRewards } from "@/lib/loyalty-server";
import { programStats } from "./queries";
import { formatCents } from "@/lib/money";
import { smsConfigured } from "@/lib/sms";
import { toggleLoyaltyEnabled } from "./actions";
import { ToggleSwitchForm } from "@/components/admin/toggle-switch-form";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="gap-1! px-5! py-4!">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

export default async function LoyaltyOverviewPage() {
  await requireOperator();
  const [settings, stats, rewards] = await Promise.all([
    getLoyaltySettings(),
    programStats(),
    listRewards({ activeOnly: true }),
  ]);
  const perPoint = centsPerPoint(rewards);

  return (
    <div className="space-y-6">
      <Card className="gap-0! py-0!">
        <div className="flex items-start justify-between gap-4 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">{settings.programName}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {settings.enabled ? (
                <span className="font-medium text-success">
                  On. Customers earn {settings.pointsPerDollar} points per $1 and see Rewards in the store.
                </span>
              ) : (
                <>Off. Turn it on to start enrolling customers at checkout.</>
              )}
            </p>
          </div>
          <ToggleSwitchForm
            action={toggleLoyaltyEnabled}
            checked={settings.enabled}
            label={settings.enabled ? "Turn off rewards program" : "Turn on rewards program"}
            className="pt-1"
          />
        </div>
      </Card>

      {!smsConfigured() ? (
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <span>
            No text message provider is set up, so customers can earn points but can&apos;t sign in to see or spend
            them on the live site. Add <code>TWILIO_ACCOUNT_SID</code>, <code>TWILIO_AUTH_TOKEN</code> and{" "}
            <code>TWILIO_FROM_NUMBER</code> to the environment.
          </span>
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3" data-testid="loyalty-kpis">
        <Kpi label="Members" value={stats.members.toLocaleString()} />
        <Kpi
          label="Active members"
          value={stats.activeMembers.toLocaleString()}
          hint="Ordered in the last 90 days"
        />
        <Kpi
          label="Points outstanding"
          value={stats.pointsOutstanding.toLocaleString()}
          hint={
            perPoint === null
              ? "Add a reward to estimate their value"
              : `About ${formatCents(Math.round(stats.pointsOutstanding * perPoint))} in rewards`
          }
        />
        <Kpi label="Redemptions" value={stats.redemptions30d.toLocaleString()} hint="Last 30 days" />
        <Kpi label="Discounts given" value={formatCents(stats.discountCents30d)} hint="Last 30 days" />
        <Kpi
          label="Orders from members"
          value={
            stats.memberOrderShare30d === null ? "—" : `${Math.round(stats.memberOrderShare30d * 100)}%`
          }
          hint="Last 30 days"
        />
      </div>

      <p className="text-sm text-muted-foreground">
        {rewards.length} active {rewards.length === 1 ? "reward" : "rewards"}.{" "}
        <Link href="/admin/loyalty/rewards" className="font-medium text-foreground underline underline-offset-4">
          Manage rewards
        </Link>
      </p>
    </div>
  );
}
