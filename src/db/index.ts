import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";
import { databaseUrl } from "./url";

type Db = ReturnType<typeof drizzle<typeof schema>>;

let client: Db | undefined;

// Lazy: don't read env or open the client at import time, so builds without
// DATABASE_URL succeed and only actual queries require configuration.
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    client ??= drizzle(neon(databaseUrl()), { schema });
    return client[prop as keyof Db];
  },
});

export * from "./schema";
