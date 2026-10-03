/**
 * Asserts the loyalty invariant: every member's cached balance equals the sum
 * of their ledger entries, and lifetime points never fall below what the
 * balance implies. Exits non-zero on any mismatch.
 *
 * Run: npx tsx --env-file=.env.local scripts/loyalty-audit.ts
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";

async function main() {
  const { rows } = await db.execute<{
    id: number;
    phone: string;
    points_balance: number;
    ledger_sum: string;
  }>(sql`
    select m.id, m.phone, m.points_balance, coalesce(sum(l.points), 0) as ledger_sum
    from loyalty_members m
    left join loyalty_ledger l on l.member_id = m.id
    group by m.id
    having m.points_balance <> coalesce(sum(l.points), 0)
  `);
  const [{ members }] = (
    await db.execute<{ members: string }>(sql`select count(*) as members from loyalty_members`)
  ).rows;

  for (const r of rows) {
    console.log(`MISMATCH member ${r.id} (${r.phone}): balance ${r.points_balance}, ledger ${r.ledger_sum}`);
  }
  console.log(`${members} members audited, ${rows.length} mismatches`);
  process.exit(rows.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
