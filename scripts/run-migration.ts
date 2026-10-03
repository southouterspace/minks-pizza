/**
 * Runs one SQL migration file against MINKS_DATABASE_URL over Neon's HTTP
 * driver, for environments where psql cannot reach the database. The file
 * must be a single statement; the dated files in migrations/ are each one
 * idempotent DO block, so running one twice is a no-op.
 *
 * Run: npm run db:migrate -- migrations/<file>.sql
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { databaseUrl } from "../src/db/url";

const file = process.argv[2];
if (!file) throw new Error("usage: run-migration.ts <migrations/file.sql>");
neon(databaseUrl())
  .query(readFileSync(file, "utf8"))
  .then(
    () => console.log(`applied ${file}`),
    (err: Error) => {
      console.error(err.message);
      process.exit(1);
    },
  );
