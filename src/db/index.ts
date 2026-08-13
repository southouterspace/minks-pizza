import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";
import { databaseUrl } from "./url";

const sql = neon(databaseUrl());

export const db = drizzle(sql, { schema });

export * from "./schema";
