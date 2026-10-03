import type { Metadata } from "next";
import Link from "next/link";
import { Cake, Gift, Sparkles, Users } from "lucide-react";
import { getSettings } from "@/lib/orders";
import { getCurrentMember } from "@/lib/member-auth";
import {
  LEDGER_KIND_RULES,
  formatMultiplier,
  formatPhone,
  localDate,
  SIGNUP_MIN_NET_CENTS,
} from "@/lib/loyalty";
import {
  currentPromotion,
  getLoyaltySettings,
  getMember,
  listRewards,
  memberLedger,
  memberStatus,
  refreshMember,
  type LoyaltyMember,
  type LoyaltyReward,
  type LoyaltySettings,
} from "@/lib/loyalty-server";
import { formatCents } from "@/lib/money";
import { saveBirthday, signOut } from "./actions";
import { ComingSoon } from "@/components/store/coming-soon";
import { CopyLink } from "@/components/store/copy-link";
import { RewardsSignIn } from "@/components/store/rewards-sign-in";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Rewards" };
export const dynamic = "force-dynamic";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function Progress({ fraction, label }: { fraction: number; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      className="h-2 overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, fraction * 100)}%` }} />
    </div>
  );
}

export default async function RewardsPage({ searchParams }: PageProps<"/rewards">) {
  const [store, loyalty, params] = await Promise.all([getSettings(), getLoyaltySettings(), searchParams]);
  if (!store.isPublished || !loyalty.enabled) {
    return (
      <ComingSoon
        name={store.name}
        phone={store.phone}
        logoUrl={store.logoUrl}
        logoUploadedAt={store.logoUploadedAt}
      />
    );
  }

  const next = typeof params.next === "string" && params.next.startsWith("/") ? params.next : "/rewards";
  const ref = typeof params.ref === "string" ? params.ref.slice(0, 20) : null;
  const [signedIn, rewards, promo] = await Promise.all([
    getCurrentMember(),
    listRewards({ activeOnly: true }),
    currentPromotion(loyalty),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      {promo ? (
        <p data-testid="active-promo" className="mb-6 flex items-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground">
          <Sparkles className="size-4 shrink-0" aria-hidden />
          {promo.name}: {formatMultiplier(promo.multiplierBps)} points on every order today.
        </p>
      ) : null}
      {signedIn ? (
        <MemberView member={signedIn} loyalty={loyalty} rewards={rewards} />
      ) : (
        <PitchView loyalty={loyalty} rewards={rewards} next={next} referralCode={ref} />
      )}
    </div>
  );
}

function PitchView({
  loyalty,
  rewards,
  next,
  referralCode,
}: {
  loyalty: LoyaltySettings;
  rewards: LoyaltyReward[];
  next: string;
  referralCode: string | null;
}) {
  const multiplied = loyalty.tiers.filter((t) => t.multiplierBps > 10_000);
  return (
    <div className="grid gap-10 md:grid-cols-[1fr_320px]">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{loyalty.programName}</h1>
        <p className="mt-3 text-lg text-muted-foreground">
          Earn {loyalty.pointsPerDollar} points for every $1 you spend on food and drinks, then trade them for
          free food.
        </p>
        {referralCode ? (
          <p data-testid="referral-banner" className="mt-5 flex items-start gap-2 rounded-lg border border-border px-4 py-3 text-sm">
            <Users className="mt-0.5 size-4 shrink-0" aria-hidden />
            A friend invited you: you both get bonus points after your first order.
          </p>
        ) : null}

        <h2 className="mt-10 text-sm font-semibold">Rewards</h2>
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
          {rewards.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="min-w-0">
                <span className="block text-sm font-medium">{r.name}</span>
                {r.description ? (
                  <span className="block text-xs text-muted-foreground">{r.description}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                {r.pointsCost.toLocaleString()} pts
              </span>
            </li>
          ))}
        </ul>

        <h2 className="mt-10 text-sm font-semibold">More ways to earn</h2>
        <ul className="mt-3 space-y-3 text-sm text-muted-foreground">
          {loyalty.signupBonus > 0 ? (
            <li className="flex gap-3">
              <Gift className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden />
              {loyalty.signupBonus} bonus points with your first order of {formatCents(SIGNUP_MIN_NET_CENTS)} or more.
            </li>
          ) : null}
          {loyalty.birthdayPoints > 0 ? (
            <li className="flex gap-3">
              <Cake className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden />
              {loyalty.birthdayPoints} points in your birthday month.
            </li>
          ) : null}
          {loyalty.referrerBonus > 0 ? (
            <li className="flex gap-3">
              <Users className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden />
              {loyalty.referrerBonus} points for each friend you refer, once they order. They get{" "}
              {loyalty.refereeBonus}.
            </li>
          ) : null}
          {multiplied.length > 0 ? (
            <li className="flex gap-3">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden />
              <span>
                Regulars earn faster:{" "}
                {multiplied
                  .map((t) => `${t.name} members earn ${formatMultiplier(t.multiplierBps)} after ${t.minPoints.toLocaleString()} points in a year`)
                  .join("; ")}
                .
              </span>
            </li>
          ) : null}
        </ul>
        {loyalty.expirationMonths !== null ? (
          <p className="mt-6 text-xs text-muted-foreground">
            Points expire after {loyalty.expirationMonths} months without an order.
          </p>
        ) : null}
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="text-base">Join or sign in</CardTitle>
        </CardHeader>
        <CardContent>
          <RewardsSignIn next={next} referralCode={referralCode} />
        </CardContent>
      </Card>
    </div>
  );
}

async function MemberView({
  member: signedIn,
  loyalty,
  rewards,
}: {
  member: LoyaltyMember;
  loyalty: LoyaltySettings;
  rewards: LoyaltyReward[];
}) {
  await refreshMember(signedIn.id);
  const member = (await getMember(signedIn.id)) ?? signedIn;
  const [status, ledger] = await Promise.all([memberStatus(member, loyalty), memberLedger(member.id)]);
  const year = localDate(new Date(), loyalty.timezone).year;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            {member.name ? `Hi, ${member.name}` : formatPhone(member.phone)}
          </p>
          <h1 className="mt-1 text-4xl font-bold tracking-tight tabular-nums" data-testid="points-balance">
            {member.pointsBalance.toLocaleString()} <span className="text-lg font-medium text-muted-foreground">points</span>
          </h1>
        </div>
        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm" className="text-muted-foreground">
            Sign out
          </Button>
        </form>
      </div>

      <Card>
        <CardContent className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm">
              <span className="font-semibold" data-testid="member-tier">{status.tier.name}</span>
              <span className="text-muted-foreground"> · earning {formatMultiplier(status.tier.multiplierBps)}</span>
            </p>
            {status.next ? (
              <p className="text-xs text-muted-foreground">
                {status.pointsToNext?.toLocaleString()} points to {status.next.name}
              </p>
            ) : null}
          </div>
          {status.next ? (
            <>
              <Progress fraction={status.fraction} label={`Progress to ${status.next.name}`} />
              <p className="text-xs text-muted-foreground">
                {status.next.name} earns {formatMultiplier(status.next.multiplierBps)} points. Tiers count points earned on
                orders in the last 12 months.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">You&apos;re at our top tier.</p>
          )}
        </CardContent>
      </Card>

      <section>
        <h2 className="text-sm font-semibold">Rewards</h2>
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border" data-testid="reward-ladder">
          {rewards.map((r) => {
            const ready = member.pointsBalance >= r.pointsCost;
            return (
              <li key={r.id} className="space-y-2 px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{r.name}</span>
                    {r.description ? (
                      <span className="block text-xs text-muted-foreground">{r.description}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                    {r.pointsCost.toLocaleString()} pts
                  </span>
                </div>
                <Progress fraction={Math.min(1, member.pointsBalance / r.pointsCost)} label={`Progress to ${r.name}`} />
                <p className={cn("text-xs", ready ? "font-medium text-success" : "text-muted-foreground")}>
                  {ready
                    ? "Ready to redeem at checkout"
                    : `${(r.pointsCost - member.pointsBalance).toLocaleString()} points to go`}
                </p>
              </li>
            );
          })}
        </ul>
        <Link href="/" className="mt-3 inline-block text-sm font-medium underline underline-offset-4">
          Order now
        </Link>
      </section>

      <div className="grid gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Refer a friend</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              You get {loyalty.referrerBonus} points and they get {loyalty.refereeBonus} after their first order.
            </p>
            <CopyLink path={`/rewards?ref=${member.referralCode}`} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Birthday</CardTitle>
          </CardHeader>
          <CardContent>
            {member.birthMonth && member.birthDay ? (
              <p className="text-sm" data-testid="birthday">
                {MONTHS[member.birthMonth - 1]} {member.birthDay}
                <span className="block text-xs text-muted-foreground">Contact the store to change it.</span>
              </p>
            ) : (
              <form action={saveBirthday} className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Get {loyalty.birthdayPoints} points in your birthday month. You can set it once.
                </p>
                <div className="flex gap-2">
                  <NativeSelect name="month" aria-label="Birth month" required defaultValue="">
                    <NativeSelectOption value="" disabled>Month</NativeSelectOption>
                    {MONTHS.map((m, i) => (
                      <NativeSelectOption key={m} value={i + 1}>{m}</NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <NativeSelect name="day" aria-label="Birth day" required defaultValue="">
                    <NativeSelectOption value="" disabled>Day</NativeSelectOption>
                    {Array.from({ length: 31 }, (_, i) => (
                      <NativeSelectOption key={i} value={i + 1}>{i + 1}</NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Button type="submit" variant="outline" className="h-9!">Save</Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </div>

      <section>
        <h2 className="text-sm font-semibold">Activity</h2>
        {ledger.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No points yet. Place an order with {formatPhone(member.phone)} to start earning.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border" data-testid="activity">
            {ledger.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <span className="min-w-0">
                  <span className="block">
                    {LEDGER_KIND_RULES[e.kind].label}
                    {e.note ? <span className="text-muted-foreground"> · {e.note}</span> : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {e.createdAt.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      ...(e.createdAt.getFullYear() !== year ? { year: "numeric" } : {}),
                      timeZone: loyalty.timezone,
                    })}
                    {e.orderId && e.orderNumber ? (
                      <>
                        {" · "}
                        <Link href={`/order/${e.orderId}`} className="underline underline-offset-4">
                          Order #{e.orderNumber}
                        </Link>
                      </>
                    ) : null}
                  </span>
                </span>
                <span className={cn("shrink-0 font-medium tabular-nums", e.points > 0 ? "text-success" : "text-muted-foreground")}>
                  {e.points > 0 ? "+" : "−"}
                  {Math.abs(e.points).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
