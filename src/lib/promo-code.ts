/**
 * Case-, space- and dash-insensitive matching form: " pizza-10 " → "PIZZA10".
 * Its own module so the storefront can match codes without pulling in zod.
 */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]+/g, "");
}
