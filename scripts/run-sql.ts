/**
 * Runs one SQL file against MINKS_DATABASE_URL over Neon's HTTP driver, for
 * environments where psql cannot reach the database. The file must be a
 * single statement (migrate-pos.sql is one DO block).
 *
 * Run: npx tsx --env-file=.env.local scripts/run-sql.ts scripts/migrate-pos.sql
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { databaseUrl } from "../src/db/url";

const file = process.argv[2];
if (!file) throw new Error("usage: run-sql.ts <file.sql>");
neon(databaseUrl())
  .query(readFileSync(file, "utf8"))
  .then(
    () => console.log(`applied ${file}`),
    (err: Error) => {
      console.error(err.message);
      process.exit(1);
    },
  );
