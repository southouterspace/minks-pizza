/**
 * Loyalty data access. Every balance change goes through `ledgerStatement`:
 * one SQL statement that appends to the ledger and moves the cached balance
 * together, so it can ride inside the same `db.batch` as the order write
 * that caused it. Not server-only: the order pipeline and scripts import it.
 */
import { randomInt, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, isNull, max, sql, sum, type SQL } from "drizzle-orm";
import {
  categories,
  db,
  loyaltyLedger,
  loyaltyMembers,
  loyaltyPromotions,
  loyaltyRewards,
  loyaltySettings,
  orders,
} from "@/db";
import {
  EXPIRY_RESTORE_DAYS,
  LEDGER_KINDS,
  LEDGER_KIND_RULES,
  REFERRER_BONUS_YEARLY_CAP,
  SIGNUP_MIN_NET_CENTS,
  activePromotion,
  birthdayGrantDue,
  earnPoints,
  expiryDue,
  localDate,
  rewardEffectSchema,
  rewardPrice,
  tierProgress,
  type LedgerKind,
  type RewardEffect,
  type RewardPrice,
} from "@/lib/loyalty";
import { localDateOf, zonedInstant } from "@/lib/zoned";

export type LoyaltySettings = typeof loyaltySettings.$inferSelect;
export type LoyaltyMember = typeof loyaltyMembers.$inferSelect;
export type LoyaltyReward = Omit<typeof loyaltyRewards.$inferSelect, "effect"> & {
  effect: RewardEffect;
  /** What it costs a customer today; pointsCost is the operator's list price. */
  price: RewardPrice;
};

export const INSUFFICIENT_POINTS = "You don't have enough points for that reward anymore.";

export const ledgerKey = {
  earn: (orderId: string) => `earn:order:${orderId}`,
  redeem: (orderId: string) => `redeem:order:${orderId}`,
  redeemRefund: (orderId: string) => `redeem_refund:order:${orderId}`,
  signup: (memberId: number) => `signup:${memberId}`,
  birthday: (memberId: number, year: number) => `birthday:${memberId}:${year}`,
  referrer: (refereeId: number) => `referral:referrer:${refereeId}`,
  referee: (refereeId: number) => `referral:referee:${refereeId}`,
  expire: (memberId: number, lastActivityAt: Date) =>
    `expire:${memberId}:${lastActivityAt.getTime()}`,
  adjust: () => `adjust:${randomUUID()}`,
  restore: (expireEntryId: number) => `restore:${expireEntryId}`,
};

/**
 * Where an entry's member and points come from: fixed values, or a SELECT
 * yielding `member_id, points` (zero or one row) evaluated inside the
 * statement, so conditions like "only if the order is completed" hold at
 * write time. A source with zero points or no row writes nothing.
 */
type EntrySource = { memberId: number; points: number } | SQL;

export type LedgerEntry = {
  kind: LedgerKind;
  idemKey: string;
  from: EntrySource;
  orderId?: string | null;
  note?: string | null;
  operatorId?: number | null;
  reversesEntryId?: number | null;
};

/**
 * The one way points move. Replays are no-ops (unique idem_key), and a
 * debit past zero trips the points_balance CHECK, failing the whole batch.
 */
export function ledgerStatement(entry: LedgerEntry) {
  const source =
    "memberId" in entry.from
      ? sql`select ${entry.from.memberId}::int as member_id, ${entry.from.points}::int as points`
      : entry.from;
  const lifetime = LEDGER_KIND_RULES[entry.kind].lifetime
    ? sql`greatest(e.points, 0)`
    : sql`0`;
  return db.execute(sql`
    with e as (
      insert into loyalty_ledger (member_id, kind, points, order_id, idem_key, note, operator_id, reverses_entry_id)
      select s.member_id, ${entry.kind}::loyalty_entry_kind, s.points, ${entry.orderId ?? null}::uuid,
             ${entry.idemKey}, ${entry.note ?? null}, ${entry.operatorId ?? null}::int,
             ${entry.reversesEntryId ?? null}::int
      from (${source}) s
      where s.member_id is not null and s.points <> 0
      on conflict (idem_key) do nothing
      returning member_id, points
    )
    update loyalty_members m
    set points_balance = m.points_balance + e.points,
        lifetime_points = m.lifetime_points + ${lifetime}
    from e
    where m.id = e.member_id
  `);
}

/** The Postgres error code, looking through drizzle's wrapping. */
function pgCode(err: unknown): string | null {
  for (let e = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/** check_violation: the points_balance >= 0 CHECK. */
export function isInsufficientPoints(err: unknown): boolean {
  return pgCode(err) === "23514";
}

// ---------------------------------------------------------------------------
// Settings and catalog
// ---------------------------------------------------------------------------

export async function getLoyaltySettings(): Promise<LoyaltySettings> {
  const [row] = await db.select().from(loyaltySettings).where(eq(loyaltySettings.id, 1));
  if (row) return row;
  const [created] = await db
    .insert(loyaltySettings)
    .values({ id: 1 })
    .onConflictDoUpdate({ target: loyaltySettings.id, set: { id: 1 } })
    .returning();
  return created;
}

function parseReward(row: typeof loyaltyRewards.$inferSelect): LoyaltyReward {
  return { ...row, effect: rewardEffectSchema.parse(row.effect), price: rewardPrice(row, new Date()) };
}

export async function listRewards({ activeOnly }: { activeOnly: boolean }) {
  const rows = await db
    .select()
    .from(loyaltyRewards)
    .where(activeOnly ? eq(loyaltyRewards.isActive, true) : undefined)
    .orderBy(asc(loyaltyRewards.sortOrder), asc(loyaltyRewards.pointsCost));
  return rows.map(parseReward);
}

export async function getReward(id: number): Promise<LoyaltyReward | null> {
  const [row] = await db.select().from(loyaltyRewards).where(eq(loyaltyRewards.id, id));
  return row ? parseReward(row) : null;
}

export function listPromotions() {
  return db.select().from(loyaltyPromotions).orderBy(desc(loyaltyPromotions.createdAt));
}

export async function currentPromotion(settings: LoyaltySettings, at = new Date()) {
  return activePromotion(await listPromotions(), at, settings.timezone);
}

/**
 * Starter reward ladder, written only while the catalog is empty, so running
 * it again (enable, disable, enable) never duplicates rewards.
 */
export async function seedDefaultRewards(): Promise<void> {
  const cats = await db
    .select({ id: categories.id, name: categories.name, station: categories.station })
    .from(categories);
  const pizzaIds = cats.filter((c) => c.station === "pizza").map((c) => c.id);
  const sideIds = cats.filter((c) => /side|dessert/i.test(c.name)).map((c) => c.id);

  const defaults: { name: string; description: string; pointsCost: number; effect: RewardEffect }[] = [
    {
      name: "$3 off",
      description: "Take $3 off any order.",
      pointsCost: 300,
      effect: { kind: "amount_off", amountOffCents: 300 },
    },
  ];
  if (sideIds.length > 0) {
    defaults.push({
      name: "Free side",
      description: "Any side or salad, on us.",
      pointsCost: 700,
      effect: { kind: "free_item", categoryIds: sideIds, maxValueCents: 999 },
    });
  }
  if (pizzaIds.length > 0) {
    defaults.push({
      name: "Free large pizza",
      description: "Any pizza up to $22.",
      pointsCost: 1500,
      effect: { kind: "free_item", categoryIds: pizzaIds, maxValueCents: 2200 },
    });
  }

  const values = defaults.map(
    (d, i) => sql`(${d.name}, ${d.description}, ${d.pointsCost}::int, ${JSON.stringify(d.effect)}::jsonb, ${i}::int)`,
  );
  await db.execute(sql`
    insert into loyalty_rewards (name, description, points_cost, effect, sort_order)
    select * from (values ${sql.join(values, sql`, `)}) v
    where not exists (select 1 from loyalty_rewards)
  `);
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function newReferralCode(): string {
  return Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

export async function getMember(id: number): Promise<LoyaltyMember | null> {
  const [m] = await db.select().from(loyaltyMembers).where(eq(loyaltyMembers.id, id));
  return m ?? null;
}

export async function memberByReferralCode(code: string): Promise<LoyaltyMember | null> {
  const [m] = await db
    .select()
    .from(loyaltyMembers)
    .where(eq(loyaltyMembers.referralCode, code.trim().toUpperCase()));
  return m ?? null;
}

/**
 * Enrolls a normalized phone, or returns the member who already has it. A
 * referral link only counts for a phone new to the program.
 */
export async function findOrCreateMember(
  phone: string,
  details: { name?: string | null; referredById?: number | null } = {},
): Promise<{ member: LoyaltyMember; created: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const [created] = await db
        .insert(loyaltyMembers)
        .values({
          phone,
          name: details.name || null,
          referralCode: newReferralCode(),
          referredById: details.referredById ?? null,
        })
        .onConflictDoNothing({ target: loyaltyMembers.phone })
        .returning();
      if (created) return { member: created, created: true };
      const [existing] = await db.select().from(loyaltyMembers).where(eq(loyaltyMembers.phone, phone));
      return { member: existing, created: false };
    } catch (err) {
      // Phone conflicts are absorbed above, so a unique violation here is a
      // referral-code collision: roll a new code.
      if (pgCode(err) !== "23505" || attempt >= 3) throw err;
    }
  }
}

/** Points from `earn` entries in the trailing 365 days decide the tier. */
export async function qualifyingPoints(memberId: number): Promise<number> {
  const [row] = await db
    .select({ total: sum(loyaltyLedger.points) })
    .from(loyaltyLedger)
    .where(
      and(
        eq(loyaltyLedger.memberId, memberId),
        eq(loyaltyLedger.kind, "earn"),
        gte(loyaltyLedger.createdAt, sql`now() - interval '365 days'`),
      ),
    );
  return Number(row?.total ?? 0);
}

export async function memberStatus(member: LoyaltyMember, settings: LoyaltySettings) {
  return tierProgress(await qualifyingPoints(member.id), settings.tiers);
}

// ---------------------------------------------------------------------------
// Lifecycle statements
// ---------------------------------------------------------------------------

const completedOrderOf = (memberId: number, extra: SQL = sql`true`) => sql`
  exists (select 1 from orders o
          where o.loyalty_member_id = ${memberId} and o.status = 'completed' and ${extra})`;

/**
 * Bonuses that wait for a member's first completed order: the welcome bonus
 * (on an order of at least $15 net) and both sides of a referral. Safe to
 * include anywhere; each pays once per member.
 */
function settlementStatements(memberId: number, settings: LoyaltySettings) {
  return [
    ledgerStatement({
      kind: "signup_bonus",
      idemKey: ledgerKey.signup(memberId),
      from: sql`select ${memberId}::int as member_id, ${settings.signupBonus}::int as points
                where ${completedOrderOf(
                  memberId,
                  sql`o.subtotal_cents - o.discount_cents >= ${SIGNUP_MIN_NET_CENTS}`,
                )}`,
    }),
    ledgerStatement({
      kind: "referee_bonus",
      idemKey: ledgerKey.referee(memberId),
      from: sql`select m.id as member_id, ${settings.refereeBonus}::int as points
                from loyalty_members m
                where m.id = ${memberId} and m.referred_by_id is not null
                  and ${completedOrderOf(memberId)}`,
    }),
    ledgerStatement({
      kind: "referrer_bonus",
      idemKey: ledgerKey.referrer(memberId),
      note: "Friend's first order",
      from: sql`select m.referred_by_id as member_id, ${settings.referrerBonus}::int as points
                from loyalty_members m
                where m.id = ${memberId} and m.referred_by_id is not null
                  and ${completedOrderOf(memberId)}
                  and (select count(*) from loyalty_ledger l
                       where l.member_id = m.referred_by_id
                         and l.kind = 'referrer_bonus'
                         and l.created_at > now() - interval '365 days') < ${REFERRER_BONUS_YEARLY_CAP}`,
    }),
  ];
}

/**
 * Batch these after the statement that completes an order: post the points
 * promised at checkout, restart the member's expiry clock, and settle any
 * first-order bonuses. Each statement re-checks that the order is completed.
 */
export function completionStatements(
  order: { id: string; loyaltyMemberId: number | null },
  settings: LoyaltySettings,
) {
  if (order.loyaltyMemberId === null) return [];
  return [
    ledgerStatement({
      kind: "earn",
      idemKey: ledgerKey.earn(order.id),
      orderId: order.id,
      from: sql`select o.loyalty_member_id as member_id, o.loyalty_points_earned as points
                from orders o where o.id = ${order.id} and o.status = 'completed'`,
    }),
    db.execute(sql`
      update loyalty_members m set last_activity_at = greatest(m.last_activity_at, o.updated_at)
      from orders o
      where o.id = ${order.id} and o.status = 'completed' and m.id = o.loyalty_member_id`),
    ...settlementStatements(order.loyaltyMemberId, settings),
  ];
}

/** Batch after canceling an order: gives back points spent on its reward. */
export function cancellationStatements(orderId: string) {
  return [
    ledgerStatement({
      kind: "redeem_refund",
      idemKey: ledgerKey.redeemRefund(orderId),
      orderId,
      from: sql`select l.member_id, -l.points as points
                from loyalty_ledger l
                where l.idem_key = ${ledgerKey.redeem(orderId)}
                  and exists (select 1 from orders o where o.id = ${orderId} and o.status = 'canceled')`,
    }),
  ];
}

/**
 * Lazy grants for a member: expiry, birthday and first-order settlement.
 * Every one is idempotent, so this runs on every sign-in and page load.
 */
export async function refreshMember(memberId: number, now = new Date()): Promise<void> {
  const [member, settings, [last]] = await Promise.all([
    getMember(memberId),
    getLoyaltySettings(),
    db
      .select({ at: max(orders.updatedAt) })
      .from(orders)
      .where(and(eq(orders.loyaltyMemberId, memberId), eq(orders.status, "completed"))),
  ]);
  if (!member) return;

  const statements = settlementStatements(memberId, settings);
  if (expiryDue(member, now, settings.expirationMonths)) {
    // Only if nothing has happened since we looked; the key pins that moment.
    statements.push(
      ledgerStatement({
        kind: "expire",
        idemKey: ledgerKey.expire(memberId, member.lastActivityAt),
        from: sql`select id as member_id, -points_balance as points
                  from loyalty_members
                  where id = ${memberId} and points_balance > 0
                    and date_trunc('milliseconds', last_activity_at) = ${member.lastActivityAt.toISOString()}::timestamptz`,
      }),
    );
  }
  if (birthdayGrantDue({ ...member, lastCompletedOrderAt: last?.at ?? null }, now, settings.timezone)) {
    statements.push(
      ledgerStatement({
        kind: "birthday",
        idemKey: ledgerKey.birthday(memberId, localDate(now, settings.timezone).year),
        from: { memberId, points: settings.birthdayPoints },
      }),
    );
  }
  const [first, ...rest] = statements;
  await db.batch([first, ...rest]);
}

// ---------------------------------------------------------------------------
// Claiming orders placed before joining or signing in
// ---------------------------------------------------------------------------

export type ClaimResult = "claimed" | "not_found" | "not_completed" | "already_linked";

/**
 * Links completed guest orders to a member and posts their points at the base
 * rate (no tier or promotion: those applied to the member at order time,
 * which we can't know). The earn key is the order's, so a claim can't
 * double-post with a completion.
 */
async function claimOrders(memberId: number, where: SQL): Promise<number> {
  const settings = await getLoyaltySettings();
  const { rows } = await db.execute<{ id: string; net: number }>(sql`
    select id, subtotal_cents - discount_cents as net from orders
    where status = 'completed' and loyalty_member_id is null and ${where}`);
  for (const order of rows) {
    const points = earnPoints({
      netCents: order.net,
      pointsPerDollar: settings.pointsPerDollar,
      tierMultiplierBps: 10_000,
      promoMultiplierBps: 10_000,
    });
    await db.batch([
      db
        .update(orders)
        .set({ loyaltyMemberId: memberId, loyaltyPointsEarned: points })
        .where(and(eq(orders.id, order.id), isNull(orders.loyaltyMemberId))),
      ...completionStatements({ id: order.id, loyaltyMemberId: memberId }, settings),
    ]);
  }
  return rows.length;
}

/** Completed orders from the last 30 days placed with the member's phone. */
export function claimRecentOrders(member: { id: number; phone: string }): Promise<number> {
  return claimOrders(
    member.id,
    sql`regexp_replace(customer_phone, '[^0-9]', '', 'g') in (${member.phone}, ${`1${member.phone}`})
        and placed_at > now() - interval '30 days'`,
  );
}

/** Operator override: any completed, unclaimed order, whatever its phone. */
export async function claimOrderByNumber(memberId: number, orderNumber: number): Promise<ClaimResult> {
  const [order] = await db
    .select({ status: orders.status, memberId: orders.loyaltyMemberId })
    .from(orders)
    .where(eq(orders.orderNumber, orderNumber));
  if (!order) return "not_found";
  if (order.memberId !== null) return "already_linked";
  if (order.status !== "completed") return "not_completed";
  return (await claimOrders(memberId, sql`order_number = ${orderNumber}`)) > 0 ? "claimed" : "already_linked";
}

export function memberOrders(memberId: number, limit = 20) {
  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      placedAt: orders.placedAt,
      pointsEarned: orders.loyaltyPointsEarned,
    })
    .from(orders)
    .where(eq(orders.loyaltyMemberId, memberId))
    .orderBy(desc(orders.placedAt))
    .limit(limit);
}

/** An expiry an operator can still undo: recent, and not restored yet. */
const restorableExpiry = sql<boolean>`(
  ${loyaltyLedger.kind} = 'expire'
  and ${loyaltyLedger.createdAt} > now() - make_interval(days => ${EXPIRY_RESTORE_DAYS})
  and not exists (select 1 from loyalty_ledger r where r.reverses_entry_id = ${loyaltyLedger.id}))`;

/** Gives back an expiry's points; false when it isn't restorable. */
export async function restoreExpiry(entryId: number, operatorId: number): Promise<boolean> {
  const { rowCount } = await ledgerStatement({
    kind: "restore",
    idemKey: ledgerKey.restore(entryId),
    reversesEntryId: entryId,
    operatorId,
    from: sql`select ${loyaltyLedger.memberId} as member_id, -${loyaltyLedger.points} as points
              from ${loyaltyLedger} where ${loyaltyLedger.id} = ${entryId} and ${restorableExpiry}`,
  });
  return rowCount > 0;
}

export async function birthdayBonusThisYear(memberId: number, timezone: string): Promise<boolean> {
  const yearStart = zonedInstant(`${localDateOf(new Date(), timezone).slice(0, 4)}-01-01`, "00:00", timezone);
  const [row] = await db
    .select({ id: loyaltyLedger.id })
    .from(loyaltyLedger)
    .where(
      and(
        eq(loyaltyLedger.memberId, memberId),
        eq(loyaltyLedger.kind, "birthday"),
        gte(loyaltyLedger.createdAt, yearStart),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export function memberLedger(memberId: number, limit = 50) {
  return db
    .select({
      id: loyaltyLedger.id,
      kind: loyaltyLedger.kind,
      points: loyaltyLedger.points,
      note: loyaltyLedger.note,
      createdAt: loyaltyLedger.createdAt,
      orderId: loyaltyLedger.orderId,
      orderNumber: orders.orderNumber,
      restorable: restorableExpiry,
    })
    .from(loyaltyLedger)
    .leftJoin(orders, eq(orders.id, loyaltyLedger.orderId))
    .where(eq(loyaltyLedger.memberId, memberId))
    .orderBy(desc(loyaltyLedger.createdAt), desc(loyaltyLedger.id))
    .limit(limit);
}

export type BalanceMismatch = {
  id: number;
  phone: string;
  balance: number;
  ledgerSum: number;
  lifetime: number;
  ledgerLifetime: number;
};

/**
 * Members whose cached balance isn't the sum of their ledger, or whose
 * lifetime points aren't the sum of their lifetime-earning entries.
 */
export async function auditBalances(): Promise<{ members: number; mismatches: BalanceMismatch[] }> {
  const lifetimeKinds = LEDGER_KINDS.filter((k) => LEDGER_KIND_RULES[k].lifetime);
  const ledgerSum = sql<number>`coalesce(sum(${loyaltyLedger.points}), 0)::int`;
  const ledgerLifetime = sql<number>`coalesce(sum(greatest(${loyaltyLedger.points}, 0))
    filter (where ${inArray(loyaltyLedger.kind, lifetimeKinds)}), 0)::int`;
  const [mismatches, [{ members }]] = await Promise.all([
    db
      .select({
        id: loyaltyMembers.id,
        phone: loyaltyMembers.phone,
        balance: loyaltyMembers.pointsBalance,
        ledgerSum,
        lifetime: loyaltyMembers.lifetimePoints,
        ledgerLifetime,
      })
      .from(loyaltyMembers)
      .leftJoin(loyaltyLedger, eq(loyaltyLedger.memberId, loyaltyMembers.id))
      .groupBy(loyaltyMembers.id)
      .having(
        sql`${loyaltyMembers.pointsBalance} <> ${ledgerSum} or ${loyaltyMembers.lifetimePoints} <> ${ledgerLifetime}`,
      ),
    db.select({ members: count() }).from(loyaltyMembers),
  ]);
  return { members, mismatches };
}

// ---------------------------------------------------------------------------
// Operator reporting
// ---------------------------------------------------------------------------

/** What one point is worth, judged by the cheapest reward to reach. */
export function centsPerPoint(rewards: LoyaltyReward[]): number | null {
  const cheapest = rewards
    .filter((r) => r.isActive)
    .toSorted((a, b) => a.price.cost - b.price.cost)[0];
  if (!cheapest) return null;
  const value =
    cheapest.effect.kind === "amount_off" ? cheapest.effect.amountOffCents : cheapest.effect.maxValueCents;
  return value / cheapest.price.cost;
}

export async function programStats() {
  const { rows } = await db.execute<{
    members: string;
    active_members: string;
    outstanding: string | null;
    redemptions: string;
    discount_cents: string | null;
    orders: string;
    member_orders: string;
  }>(sql`
    select
      (select count(*) from loyalty_members) as members,
      (select count(distinct loyalty_member_id) from orders
        where loyalty_member_id is not null and status <> 'canceled'
          and placed_at > now() - interval '90 days') as active_members,
      (select sum(points_balance) from loyalty_members) as outstanding,
      count(*) filter (where loyalty_points_redeemed > 0) as redemptions,
      sum(discount_cents) as discount_cents,
      count(*) as orders,
      count(*) filter (where loyalty_member_id is not null) as member_orders
    from orders
    where status <> 'canceled' and placed_at > now() - interval '30 days'
  `);
  const r = rows[0];
  return {
    members: Number(r.members),
    activeMembers: Number(r.active_members),
    pointsOutstanding: Number(r.outstanding ?? 0),
    redemptions30d: Number(r.redemptions),
    discountCents30d: Number(r.discount_cents ?? 0),
    memberOrderShare30d: Number(r.orders) === 0 ? null : Number(r.member_orders) / Number(r.orders),
  };
}

export async function searchMembers(query: string, limit = 50) {
  const q = query.trim();
  const digits = q.replace(/\D/g, "");
  const filter =
    q === ""
      ? sql`true`
      : digits.length >= 3 && digits.length === q.replace(/[\s()+.-]/g, "").length
        ? sql`m.phone like ${`%${digits}%`}`
        : sql`m.name ilike ${`%${q}%`}`;
  const { rows } = await db.execute<{
    id: number;
    name: string | null;
    phone: string;
    points_balance: number;
    lifetime_points: number;
    last_activity_at: string;
    qualifying: string;
  }>(sql`
    select m.id, m.name, m.phone, m.points_balance, m.lifetime_points, m.last_activity_at,
      coalesce((select sum(l.points) from loyalty_ledger l
                where l.member_id = m.id and l.kind = 'earn'
                  and l.created_at > now() - interval '365 days'), 0) as qualifying
    from loyalty_members m
    where ${filter}
    order by m.last_activity_at desc
    limit ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    pointsBalance: r.points_balance,
    lifetimePoints: r.lifetime_points,
    lastActivityAt: new Date(r.last_activity_at),
    qualifyingPoints: Number(r.qualifying),
  }));
}
