/**
 * Asserts the loyalty invariants: every member's cached balance equals the
 * sum of their ledger, and lifetime points equal the sum of their
 * lifetime-earning entries. Exits non-zero on any mismatch.
 *
 * Run: npx tsx --env-file=.env.local scripts/loyalty-audit.ts
 */
import { auditBalances } from "../src/lib/loyalty-server";

auditBalances().then(
  ({ members, mismatches }) => {
    for (const m of mismatches) {
      console.log(
        `MISMATCH member ${m.id} (${m.phone}): balance ${m.balance} vs ledger ${m.ledgerSum}, lifetime ${m.lifetime} vs ledger ${m.ledgerLifetime}`,
      );
    }
    console.log(`${members} members audited, ${mismatches.length} mismatches`);
    process.exit(mismatches.length === 0 ? 0 : 1);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
