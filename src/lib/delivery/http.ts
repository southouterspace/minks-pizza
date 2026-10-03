import { createHash, timingSafeEqual } from "node:crypto";
import { CourierError } from "./types";

export type Fetch = typeof globalThis.fetch;

/** Sends JSON, returns the parsed body, and turns any non-2xx into a CourierError. */
export async function requestJson(
  fetchImpl: Fetch,
  label: string,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: unknown },
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: init.method,
    headers: { "Content-Type": "application/json", ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const json: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const message =
      json && typeof json === "object" && "message" in json && typeof json.message === "string"
        ? json.message
        : `HTTP ${res.status}`;
    throw new CourierError(`${label}: ${message}`);
  }
  return json;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Constant-time string comparison that does not leak the length either. */
export function secretsMatch(given: string, expected: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export function dateOrNull(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/** Webhooks fill in what they know; a missing field never clears a stored one. */
export function presentOnly<T extends object>(o: T): Partial<{ [K in keyof T]: NonNullable<T[K]> }> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as Partial<{
    [K in keyof T]: NonNullable<T[K]>;
  }>;
}
