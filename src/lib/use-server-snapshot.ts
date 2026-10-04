/**
 * A screen's copy of one server snapshot (the POS board, the KDS), kept
 * fresh by polling. Writes go through `mutate`, so a poll that was already
 * on the wire when a write started or finished can't put the pre-write
 * state back on screen. Client only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** No snapshot taken in for this long, about three missed polls, and a screen warns that it is behind. */
export const SYNC_STALE_MS = 15_000;

export type MutateOptions<T, R> = {
  /** Shown at once, before the server answers. */
  optimistic?: (current: T) => T;
  /** The fresh snapshot a write's response carries, if it carries one. */
  snapshot?: (result: R) => T | null;
};

export type ServerSnapshot<T> = {
  data: T;
  /** Wall-clock ms of the last snapshot taken in. */
  lastSync: number;
  /** False once a poll fails, true again on the next one that lands. */
  online: boolean;
  refresh: () => Promise<void>;
  mutate: <R>(write: () => Promise<R>, options?: MutateOptions<T, R>) => Promise<R>;
};

export function useServerSnapshot<T>(
  url: string,
  initial: T,
  { intervalMs, onSnapshot }: { intervalMs: number; onSnapshot?: (next: T) => void },
): ServerSnapshot<T> {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [lastSync, setLastSync] = useState(() => Date.now());
  const [online, setOnline] = useState(true);
  // Bumped when a write starts and when it settles; a poll is only taken in
  // if no write began or ended while it was on the wire.
  const version = useRef(0);
  const inFlight = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const onSnapshotRef = useRef(onSnapshot);
  useEffect(() => {
    onSnapshotRef.current = onSnapshot;
  });

  const accept = useCallback((next: T) => {
    onSnapshotRef.current?.(next);
    setData(next);
    setLastSync(Date.now());
    setOnline(true);
  }, []);

  const refresh = useCallback(async () => {
    const startedAt = version.current;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/admin/login");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as T;
      if (inFlight.current === 0 && version.current === startedAt) accept(next);
    } catch {
      setOnline(false);
    }
  }, [url, router, accept]);

  const mutate = useCallback(
    async <R>(write: () => Promise<R>, { optimistic, snapshot }: MutateOptions<T, R> = {}): Promise<R> => {
      const mine = ++version.current;
      inFlight.current += 1;
      if (optimistic) setData(optimistic);
      let settled = false;
      // Writes reach the server in order: a KDS handoff sent before its
      // bump commits would be refused as stale.
      const send = queue.current.then(write, write);
      queue.current = send.catch(() => undefined);
      try {
        const result = await send;
        const next = snapshot?.(result) ?? null;
        if (next !== null && version.current === mine) {
          settled = true;
          accept(next);
        }
        return result;
      } finally {
        inFlight.current -= 1;
        version.current += 1;
        // An optimistic guess whose write failed, or was overtaken by
        // another write, is not what the server holds: ask it.
        if (inFlight.current === 0 && !settled && optimistic) void refresh();
      }
    },
    [accept, refresh],
  );

  useEffect(() => {
    const t = setInterval(() => void refresh(), intervalMs);
    const onOnline = () => void refresh();
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      clearInterval(t);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [refresh, intervalMs]);

  return { data, lastSync, online, refresh, mutate };
}

/** A wall clock for render code, ticking every `intervalMs`. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
