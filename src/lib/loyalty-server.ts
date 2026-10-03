/**
 * Loyalty data access. Every balance change goes through `ledgerStatement`:
 * one SQL statement that appends to the ledger and moves the cached balance
 * together, so it can ride inside the same `db.batch` as the order write
 * that caused it. Not server-only: the order pipeline and scripts import it.
 */
import { randomInt, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, isNull, sql, sum, type AnyColumn, type SQL } from "drizzle-orm";
import {
  categories,
  db,
  loyaltyLedger,
  loyaltyMembers,
  loyaltyPromotions,
  loyaltyRewards,
  loyaltySettings,
  orders,
  storeSettings,
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
  localYearMonth,
  rewardEffectSchema,
  rewardDiscount,
  rewardPrice,
  tierProgress,
  toPublicReward,
  type DiscountLine,
  type LedgerKind,
  type PublicReward,
  type RewardEffect,
  type RewardPrice,
} from "@/lib/loyalty";
import { zonedInstant } from "@/lib/zoned";

export type LoyaltySettings = typeof loyaltySettings.$inferSelect;
export type LoyaltyMember = typeof loyaltyMembers.$inferSelect;
export type LoyaltyReward = Omit<typeof loyaltyRewards.$inferSelect, "effect"> & {
  effect: RewardEffect;
  /** What it costs a customer today; pointsCost is the operator's list price. */
  price: RewardPrice;
};

/** Member-scoped keys built in SQL, for statements that find the member there. */
const memberKey = (prefix: string, memberId: SQL) => sql`${prefix} || ${memberId}::text`;

/** Idempotency keys: they only deduplicate, so nothing should query them. */
export const ledgerKey = {
  earn: (orderId: string) => `earn:order:${orderId}`,
  redeem: (orderId: string) => `redeem:order:${orderId}`,
  redeemRefund: (orderId: string) => `redeem_refund:order:${orderId}`,
  signup: (memberId: SQL) => memberKey("signup:", memberId),
  birthday: (memberId: number, year: number) => `birthday:${memberId}:${year}`,
  referrer: (refereeId: SQL) => memberKey("referral:referrer:", refereeId),
  referee: (refereeId: SQL) => memberKey("referral:referee:", refereeId),
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
  idemKey: string | SQL;
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

export type RewardOption = { reward: PublicReward; fitsCart: boolean };

/** The active catalog as a checkout offers it: each reward and whether this cart qualifies. */
export async function rewardOptions(lines: DiscountLine[], timezone: string): Promise<RewardOption[]> {
  return (await listRewards({ activeOnly: true })).map((r) => ({
    reward: toPublicReward(r, timezone),
    fitsCart: rewardDiscount(r.effect, lines).ok,
  }));
}

export function listPromotions() {
  return db.select().from(loyaltyPromotions).orderBy(desc(loyaltyPromotions.createdAt));
}

export async function currentPromotion(timezone: string, at = new Date()) {
  return activePromotion(await listPromotions(), at, timezone);
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
 * A phone that just proved itself with a login code: enrolls it, or marks the
 * existing member verified and fills in a missing name. A referral link only
 * counts for a phone new to the program.
 */
export async function enrollVerifiedMember(
  phone: string,
  details: { name: string | null; referredById: number | null },
): Promise<LoyaltyMember> {
  for (let attempt = 0; ; attempt++) {
    try {
      const [member] = await db
        .insert(loyaltyMembers)
        .values({
          phone,
          name: details.name || null,
          referralCode: newReferralCode(),
          referredById: details.referredById,
          verifiedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: loyaltyMembers.phone,
          set: {
            name: sql`coalesce(${loyaltyMembers.name}, excluded.name)`,
            verifiedAt: sql`coalesce(${loyaltyMembers.verifiedAt}, excluded.verified_at)`,
          },
        })
        .returning();
      return member;
    } catch (err) {
      // Phone conflicts become updates above, so a unique violation here is a
      // referral-code collision: roll a new code.
      if (pgCode(err) !== "23505" || attempt >= 3) throw err;
    }
  }
}

export async function memberByPhone(phone: string): Promise<LoyaltyMember | null> {
  const [m] = await db.select().from(loyaltyMembers).where(eq(loyaltyMembers.phone, phone));
  return m ?? null;
}

/**
 * Batch after inserting a guest's order: enrolls the phone if it's new and
 * links the order to its member.
 */
export function enrollStatements(orderId: string, phone: string, name: string) {
  return [
    db
      .insert(loyaltyMembers)
      .values({ phone, name: name || null, referralCode: newReferralCode() })
      .onConflictDoNothing({ target: loyaltyMembers.phone }),
    db
      .update(orders)
      .set({ loyaltyMemberId: sql`(select id from loyalty_members where phone = ${phone})` })
      .where(eq(orders.id, orderId)),
  ];
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

// Orders completed before completed_at existed carry only updated_at.
const completedAt = sql`coalesce(o.completed_at, o.updated_at)`;

/** A loyalty setting read inside the statement, so callers needn't load them. */
const setting = (column: AnyColumn) =>
  sql`(select ${column} from ${loyaltySettings} where ${loyaltySettings.id} = 1)`;

/**
 * Batch with the move that completes an order: post the points promised at
 * checkout, restart the member's expiry clock, and settle the bonuses that
 * wait for a first completed order (the welcome bonus on $15+ net, both
 * sides of a referral). Each statement re-checks in SQL that the order is
 * completed, and each bonus pays once per member.
 */
export function completionStatements(orderId: string) {
  const member = sql`(select o.loyalty_member_id from orders o where o.id = ${orderId} and o.status = 'completed')`;
  const firstOrderDone = (extra: SQL = sql`true`) => sql`
    exists (select 1 from orders o
            where o.loyalty_member_id = ${member} and o.status = 'completed' and ${extra})`;
  return [
    ledgerStatement({
      kind: "earn",
      idemKey: ledgerKey.earn(orderId),
      orderId,
      from: sql`select o.loyalty_member_id as member_id, o.loyalty_points_earned as points
                from orders o where o.id = ${orderId} and o.status = 'completed'`,
    }),
    db.execute(sql`
      update loyalty_members m set last_activity_at = greatest(m.last_activity_at, ${completedAt})
      from orders o
      where o.id = ${orderId} and o.status = 'completed' and m.id = o.loyalty_member_id`),
    ledgerStatement({
      kind: "signup_bonus",
      idemKey: ledgerKey.signup(member),
      from: sql`select ${member} as member_id, ${setting(loyaltySettings.signupBonus)} as points
                where ${firstOrderDone(sql`o.subtotal_cents - o.discount_cents >= ${SIGNUP_MIN_NET_CENTS}`)}`,
    }),
    ledgerStatement({
      kind: "referee_bonus",
      idemKey: ledgerKey.referee(member),
      from: sql`select m.id as member_id, ${setting(loyaltySettings.refereeBonus)} as points
                from loyalty_members m
                where m.id = ${member} and m.referred_by_id is not null`,
    }),
    // A referrer already at the yearly cap gets nothing for this friend, now or later.
    ledgerStatement({
      kind: "referrer_bonus",
      idemKey: ledgerKey.referrer(member),
      note: "Friend's first order",
      from: sql`select m.referred_by_id as member_id, ${setting(loyaltySettings.referrerBonus)} as points
                from loyalty_members m
                where m.id = ${member} and m.referred_by_id is not null
                  and (select count(*) from loyalty_ledger l
                       where l.member_id = m.referred_by_id
                         and l.kind = 'referrer_bonus'
                         and l.created_at > now() - interval '365 days') < ${REFERRER_BONUS_YEARLY_CAP}`,
    }),
  ];
}

/** Batch with the move that cancels an order: gives back points spent on its reward. */
export function cancellationStatements(orderId: string) {
  return [
    ledgerStatement({
      kind: "redeem_refund",
      idemKey: ledgerKey.redeemRefund(orderId),
      orderId,
      from: sql`select l.member_id, -l.points as points
                from loyalty_ledger l
                where l.order_id = ${orderId} and l.kind = 'redeem'
                  and exists (select 1 from orders o where o.id = ${orderId} and o.status = 'canceled')`,
    }),
  ];
}

/**
 * Grants that come due with time alone: expiry and the birthday bonus.
 * Idempotent, so it runs on sign-in and page loads. Returns the member as
 * it stands afterwards, or null when there is no such member.
 */
export async function refreshMember(memberId: number, now = new Date()): Promise<LoyaltyMember | null> {
  const [member, settings, [{ timezone }], [last]] = await Promise.all([
    getMember(memberId),
    getLoyaltySettings(),
    db.select({ timezone: storeSettings.timezone }).from(storeSettings),
    db
      .select({ at: sql<Date | null>`max(${completedAt})`.mapWith((v) => new Date(v)) })
      .from(sql`${orders} o`)
      .where(sql`o.loyalty_member_id = ${memberId} and o.status = 'completed'`),
  ]);
  if (!member) return null;

  const statements = [];
  if (expiryDue(member, now, settings.expirationMonths)) {
    statements.push(
      ledgerStatement({
        kind: "expire",
        idemKey: ledgerKey.expire(memberId, member.lastActivityAt),
        // Re-checked here, so an order completed since we looked wins.
        from: sql`select id as member_id, -points_balance as points
                  from loyalty_members
                  where id = ${memberId} and points_balance > 0
                    and last_activity_at + make_interval(months => ${settings.expirationMonths}) <= now()`,
      }),
    );
  }
  if (birthdayGrantDue({ ...member, lastCompletedOrderAt: last?.at ?? null }, now, timezone)) {
    statements.push(
      ledgerStatement({
        kind: "birthday",
        idemKey: ledgerKey.birthday(memberId, localYearMonth(now, timezone).year),
        from: { memberId, points: settings.birthdayPoints },
      }),
    );
  }
  const [first, ...rest] = statements;
  if (!first) return member;
  await db.batch([first, ...rest]);
  return getMember(memberId);
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
  const statements = rows.flatMap((order) => [
    db
      .update(orders)
      .set({
        loyaltyMemberId: memberId,
        loyaltyPointsEarned: earnPoints({
          netCents: order.net,
          pointsPerDollar: settings.pointsPerDollar,
          tierMultiplierBps: 10_000,
          promoMultiplierBps: 10_000,
        }),
      })
      .where(and(eq(orders.id, order.id), isNull(orders.loyaltyMemberId))),
    ...completionStatements(order.id),
  ]);
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
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
  const yearStart = zonedInstant(`${localYearMonth(new Date(), timezone).year}-01-01`, "00:00", timezone);
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
