/** Operator reporting for the loyalty admin pages. */
import "server-only";
import { desc, ilike, like, sql } from "drizzle-orm";
import { db, loyaltyMembers } from "@/db";
import { qualifyingPointsOf } from "@/lib/loyalty-server";

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
      ? undefined
      : digits.length >= 3 && digits.length === q.replace(/[\s()+.-]/g, "").length
        ? like(loyaltyMembers.phone, `%${digits}%`)
        : ilike(loyaltyMembers.name, `%${q}%`);
  return db
    .select({
      id: loyaltyMembers.id,
      name: loyaltyMembers.name,
      phone: loyaltyMembers.phone,
      pointsBalance: loyaltyMembers.pointsBalance,
      lifetimePoints: loyaltyMembers.lifetimePoints,
      lastActivityAt: loyaltyMembers.lastActivityAt,
      qualifyingPoints: qualifyingPointsOf(loyaltyMembers.id),
    })
    .from(loyaltyMembers)
    .where(filter)
    .orderBy(desc(loyaltyMembers.lastActivityAt))
    .limit(limit);
}
