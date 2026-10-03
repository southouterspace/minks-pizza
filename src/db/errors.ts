function hasPgCode(error: unknown, code: string): boolean {
  for (let e = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === code) return true;
  }
  return false;
}

/** Postgres unique_violation, possibly wrapped by drizzle. */
export function isUniqueViolation(error: unknown): boolean {
  return hasPgCode(error, "23505");
}

/** Postgres foreign_key_violation, possibly wrapped by drizzle. */
export function isForeignKeyViolation(error: unknown): boolean {
  return hasPgCode(error, "23503");
}
