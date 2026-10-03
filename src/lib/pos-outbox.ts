/**
 * The POS submit queue. Every new order is written to IndexedDB, keyed by its
 * client-minted orderId, before it is POSTed, so a crash, a dropped
 * connection or a closed tab cannot lose it. The server treats a replayed
 * orderId as a no-op that returns the stored order, so sending an entry
 * twice is harmless; the queue only has to guarantee "at least once".
 *
 * Client only. Falls back to memory where IndexedDB is unavailable (private
 * windows), which keeps the retry loop but not the crash safety.
 */
import type { MutationResult, OrderView, SubmitOrderRequest } from "@/lib/orders";

export type OutboxEntry = {
  orderId: string;
  request: SubmitOrderRequest;
  createdAt: number;
  attempts: number;
  lastError: string | null;
  /** `rejected`: the server refused it; retrying the same body won't help. */
  state: "pending" | "rejected";
};

export type SubmitOutcome =
  | { kind: "sent"; order: OrderView }
  | { kind: "queued"; error: string }
  | { kind: "locked" }
  | { kind: "rejected"; message: string };

const DB_NAME = "minks-pos";
const STORE = "outbox";
const TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const memory = new Map<string, OutboxEntry>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "orderId" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  if (!db) throw new Error("no indexeddb");
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(entry: OutboxEntry): Promise<void> {
  memory.set(entry.orderId, entry);
  await tx("readwrite", (s) => s.put(entry)).catch(() => undefined);
  notify();
}

async function remove(orderId: string): Promise<void> {
  memory.delete(orderId);
  await tx("readwrite", (s) => s.delete(orderId)).catch(() => undefined);
  notify();
}

export async function entries(): Promise<OutboxEntry[]> {
  const stored = await tx<OutboxEntry[]>("readonly", (s) => s.getAll()).catch(() => null);
  if (stored) for (const e of stored) if (!memory.has(e.orderId)) memory.set(e.orderId, e);
  return [...memory.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export async function discard(orderId: string): Promise<void> {
  await remove(orderId);
}

const listeners = new Set<() => void>();

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn();
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

type Response =
  | { kind: "ok"; order: OrderView }
  | { kind: "locked" }
  | { kind: "refused"; message: string }
  | { kind: "unreachable"; error: string };

async function post(request: SubmitOrderRequest): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("/api/pos/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: ctrl.signal,
    });
    if (res.status === 401) return { kind: "locked" };
    if (res.status >= 500) return { kind: "unreachable", error: `Server error ${res.status}` };
    const body = (await res.json()) as MutationResult | { ok: false; reason: "rejected"; message: string };
    if (body.ok) return { kind: "ok", order: body.order };
    if (body.reason === "rejected") return { kind: "refused", message: body.message };
    if (body.reason === "no_open_shift") return { kind: "refused", message: "No shift is open, so payment can't be recorded." };
    return { kind: "refused", message: `Refused: ${body.reason}` };
  } catch (err) {
    return { kind: "unreachable", error: ctrl.signal.aborted ? "Timed out" : String((err as Error).message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Entries with a POST on the wire; the replay loop leaves them alone. */
const inFlight = new Set<string>();

async function attempt(entry: OutboxEntry): Promise<SubmitOutcome> {
  inFlight.add(entry.orderId);
  const res = await post(entry.request).finally(() => inFlight.delete(entry.orderId));
  switch (res.kind) {
    case "ok":
      await remove(entry.orderId);
      return { kind: "sent", order: res.order };
    case "locked":
      return { kind: "locked" };
    case "refused":
      await put({ ...entry, attempts: entry.attempts + 1, lastError: res.message, state: "rejected" });
      return { kind: "rejected", message: res.message };
    case "unreachable":
      await put({ ...entry, attempts: entry.attempts + 1, lastError: res.error });
      return { kind: "queued", error: res.error };
  }
}

/** Saves the order locally, then tries to send it once. */
export async function submit(request: SubmitOrderRequest): Promise<SubmitOutcome> {
  const entry: OutboxEntry = {
    orderId: request.orderId,
    request,
    createdAt: Date.now(),
    attempts: 0,
    lastError: null,
    state: "pending",
  };
  await put(entry);
  return attempt(entry);
}

let draining: Promise<OrderView[]> | null = null;

/**
 * Replays every pending entry, oldest first, and returns the orders that got
 * through. Stops at the first unreachable or locked result: the rest would
 * fail the same way. Concurrent calls share one run.
 */
export function drain(): Promise<OrderView[]> {
  draining ??= (async () => {
    const sent: OrderView[] = [];
    try {
      for (const e of await entries()) {
        if (e.state !== "pending" || inFlight.has(e.orderId)) continue;
        const out = await attempt(e);
        if (out.kind === "sent") sent.push(out.order);
        if (out.kind === "queued" || out.kind === "locked") break;
      }
    } finally {
      draining = null;
    }
    return sent;
  })();
  return draining;
}

/** Puts a rejected entry back in line, e.g. after opening a shift. */
export async function retry(orderId: string): Promise<SubmitOutcome | null> {
  const e = (await entries()).find((x) => x.orderId === orderId);
  return e ? attempt({ ...e, state: "pending" }) : null;
}
