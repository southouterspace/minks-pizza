/** Runs SQL over Neon's HTTP driver (port 5432 is closed here). sqlx.ts -f file.sql | sqlx.ts "select ..." */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.REH_URL!);
async function main() {
  const [a, b] = process.argv.slice(2);
  const statements =
    a === "-f"
      ? readFileSync(b, "utf8").split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !/^(--[^\n]*\n?)+$/.test(s))
      : [a];
  for (const st of statements) {
    const rows = await sql.query(st);
    if (a !== "-f") console.log(rows.map((r) => Object.values(r).join(" | ")).join("\n"));
  }
  if (a === "-f") console.log(`ran ${statements.length} statements from ${b}`);
}
main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
