/**
 * The hosting sandbox pre-sets a stale ambient DATABASE_URL that .env files
 * cannot override, so MINKS_DATABASE_URL takes precedence when present.
 */
export function databaseUrl(): string {
  const url = process.env.MINKS_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Set MINKS_DATABASE_URL or DATABASE_URL");
  }
  return url;
}
