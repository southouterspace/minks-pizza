import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Reserves the next identity value, so a parent row and its children can go
 * in one `db.batch` (one transaction) instead of waiting on `returning`.
 * Insert it with `overridingSystemValue()`. A batch that fails burns the
 * value, which is harmless.
 */
export async function nextId(table: "time_entries" | "employees"): Promise<number> {
  const { rows } = await db.execute<{ id: number }>(sql`select nextval(pg_get_serial_sequence(${table}, 'id'))::int as id`);
  return rows[0].id;
}
