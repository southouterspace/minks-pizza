"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AArrowDown,
  AArrowUp,
  ArrowLeft,
  History,
  ListOrdered,
  Maximize,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from "lucide-react";
import {
  allDay,
  applyLocally,
  formatElapsed,
  KDS_VIEWS,
  showsOnLine,
  tapStage,
  ticketLine,
  timerLevel,
  VIEW_LABEL,
  type KdsAction,
  type KdsOrder,
  type KdsSnapshot,
  type KdsView,
} from "@/lib/kds";
import { cn } from "@/lib/utils";
import { SizeCrust, Ticket, TypeChip } from "./ticket";

type Screen = KdsView | "ready";

const POLL_MS = 4_000;
/** No successful sync for this long and the screen says so. */
const STALE_MS = 15_000;
/** How long a newly arrived ticket flashes. */
const FRESH_MS = 20_000;
const TEXT_SIZES = [16, 18, 21] as const;

// --- per-device preferences (each screen remembers its own station) --------

type Prefs = { screen: Screen; sound: boolean; textSize: number; allDay: boolean };
const DEFAULT_PREFS: Prefs = { screen: "all", sound: true, textSize: 0, allDay: true };
const PREFS_KEY = "minks:kds-prefs";

function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = { ...DEFAULT_PREFS, ...JSON.parse(raw) } as Prefs;
    const screens: readonly string[] = [...KDS_VIEWS, "ready"];
    return screens.includes(p.screen) ? p : { ...p, screen: "all" };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: Prefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or storage full: preferences just won't persist.
  }
}

// --- sound -------------------------------------------------------------------

/** Two rising tones: audible over a hood fan without being a smoke alarm. */
function chime(ctx: AudioContext) {
  const start = ctx.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    const t = start + i * 0.18;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.17);
  });
}

// --- component ---------------------------------------------------------------

export function KitchenDisplay({ initial, storeName }: { initial: KdsSnapshot; storeName: string }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initial);
  const [offsetMs, setOffsetMs] = useState(() => Date.parse(initial.serverNow) - Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [lastSync, setLastSync] = useState(() => Date.now());
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [started, setStarted] = useState(false);
  const [selected, setSelected] = useState(0);
  const [recallOpen, setRecallOpen] = useState(false);
  const [cancelAlerts, setCancelAlerts] = useState<number[]>([]);
  const [fresh, setFresh] = useState<Map<string, number>>(new Map());

  const audio = useRef<AudioContext | null>(null);
  const seen = useRef<Set<string>>(new Set(initial.line.map((o) => o.id)));
  const onScreen = useRef<Set<string>>(new Set(initial.line.map((o) => o.id)));
  const alerted = useRef<Set<string>>(new Set(initial.canceled.map((c) => c.id)));
  // Optimistic-update bookkeeping: a poll that started before the latest
  // action finished must not overwrite the action's result.
  const version = useRef(0);
  const inFlight = useRef(0);

  const view: KdsView = prefs.screen === "ready" ? "all" : prefs.screen;
  const screenNow = now + offsetMs;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after hydration
    setPrefs(loadPrefs());
  }, []);

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);

  // High-contrast dark surface and a scalable root font while mounted.
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("dark");
    return () => {
      html.classList.remove("dark");
      html.style.fontSize = "";
    };
  }, []);
  useEffect(() => {
    document.documentElement.style.fontSize = `${TEXT_SIZES[prefs.textSize] ?? 16}px`;
  }, [prefs.textSize]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  /** Folds a fresh snapshot in: new-ticket chime, cancel alerts, clock skew. */
  const receive = useCallback(
    (next: KdsSnapshot) => {
      const arrived = next.line.filter((o) => !seen.current.has(o.id));
      for (const o of next.line) seen.current.add(o.id);
      if (arrived.length > 0) {
        if (prefs.sound && audio.current) chime(audio.current);
        setFresh((f) => {
          const m = new Map(f);
          for (const o of arrived) m.set(o.id, Date.now());
          return m;
        });
      }
      const pulled = next.canceled.filter(
        (c) => onScreen.current.has(c.id) && !alerted.current.has(c.id),
      );
      for (const c of next.canceled) alerted.current.add(c.id);
      if (pulled.length > 0) {
        if (prefs.sound && audio.current) chime(audio.current);
        setCancelAlerts((a) => [...a, ...pulled.map((c) => c.number)]);
      }
      onScreen.current = new Set([...next.line, ...next.ready].map((o) => o.id));
      setOffsetMs(Date.parse(next.serverNow) - Date.now());
      setLastSync(Date.now());
      setSnapshot(next);
    },
    [prefs.sound],
  );

  const poll = useCallback(async () => {
    const startedAt = version.current;
    try {
      const res = await fetch("/api/kds", { cache: "no-store" });
      if (res.status === 401) {
        router.push("/admin/login");
        return;
      }
      if (!res.ok) return;
      const next = (await res.json()) as KdsSnapshot;
      if (inFlight.current === 0 && version.current === startedAt) receive(next);
    } catch {
      // Offline: keep showing the last known tickets; the banner says so.
    }
  }, [receive, router]);

  useEffect(() => {
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  const act = useCallback(
    async (action: KdsAction) => {
      version.current += 1;
      inFlight.current += 1;
      const mine = version.current;
      setSnapshot((s) => applyLocally(s, action, new Date(Date.now() + offsetMs).toISOString()));
      try {
        const res = await fetch("/api/kds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action),
        });
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as KdsSnapshot;
        if (version.current === mine) receive(next);
      } catch {
        toast.error("Couldn't reach the server — that tap didn't save. Try again.");
        version.current += 1;
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0 && version.current !== mine) void poll();
      }
    },
    [offsetMs, poll, receive],
  );

  const recall = useCallback(
    (order: Pick<KdsOrder, "id" | "number">) => {
      void act({ type: "recall", orderId: order.id });
      toast(`#${order.number} recalled to the line`);
    },
    [act],
  );

  const bump = useCallback(
    (order: KdsOrder) => {
      const action: KdsAction = { type: "bump", orderId: order.id, view };
      const finishes = applyLocally(snapshot, action, new Date().toISOString()).ready.some(
        (o) => o.id === order.id,
      );
      void act(action);
      // Partial bumps (one station's items) are undone by tapping the item.
      if (finishes) {
        toast(`Bumped #${order.number}`, {
          action: { label: "Undo", onClick: () => recall(order) },
          duration: 8_000,
        });
      }
    },
    [act, recall, snapshot, view],
  );

  const handoff = useCallback(
    (order: KdsOrder) => {
      void act({ type: "handoff", orderId: order.id });
      toast(`#${order.number} handed off`, {
        action: { label: "Undo", onClick: () => recall(order) },
        duration: 8_000,
      });
    },
    [act, recall],
  );

  const tickets = useMemo(
    () => (prefs.screen === "ready" ? snapshot.ready : snapshot.line.filter((o) => showsOnLine(o, view))),
    [prefs.screen, snapshot, view],
  );
  const counts = useMemo(() => {
    const c = { ready: snapshot.ready.length } as Record<Screen, number>;
    for (const v of KDS_VIEWS) c[v] = snapshot.line.filter((o) => showsOnLine(o, v)).length;
    return c;
  }, [snapshot]);
  const lateCount = snapshot.line.filter(
    (o) => timerLevel(screenNow - Date.parse(o.placedAt), snapshot.timing) === "late",
  ).length;
  const allDayRows = useMemo(() => allDay(snapshot.line, view), [snapshot.line, view]);
  const selectedIndex = Math.min(selected, Math.max(tickets.length - 1, 0));

  // Keyboard / bump bar: arrows or 1–9 select, Enter or Space bumps.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!started || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        if (n <= tickets.length) setSelected(n - 1);
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        setSelected((s) => Math.min(s + 1, tickets.length - 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === "Enter" || e.key === " ") {
        const order = tickets[selectedIndex];
        if (!order) return;
        e.preventDefault();
        if (prefs.screen === "ready") handoff(order);
        else bump(order);
      } else if (e.key === "r" || e.key === "R") {
        setRecallOpen((o) => !o);
      } else if (e.key === "a" || e.key === "A") {
        updatePrefs({ allDay: !prefs.allDay });
      } else if (e.key === "Escape") {
        setRecallOpen(false);
      } else {
        return;
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [started, tickets, selectedIndex, prefs.screen, prefs.allDay, bump, handoff, updatePrefs]);

  // Keep the screen awake while the display runs.
  useEffect(() => {
    if (!started || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const request = () => {
      if (document.visibilityState !== "visible") return;
      navigator.wakeLock.request("screen").then(
        (l) => (lock = l),
        () => {},
      );
    };
    request();
    document.addEventListener("visibilitychange", request);
    return () => {
      document.removeEventListener("visibilitychange", request);
      void lock?.release();
    };
  }, [started]);

  function start() {
    try {
      audio.current ??= new AudioContext();
      void audio.current.resume();
    } catch {
      // No Web Audio: the display still works, silently.
    }
    setStarted(true);
  }

  const stale = now - lastSync > STALE_MS;
  const showAllDay = prefs.allDay && prefs.screen !== "ready" && view !== "oven";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-zinc-950 text-zinc-50 select-none">
      <style>{`
        @keyframes kds-fresh { 0%,100% { box-shadow: 0 0 0 0 rgb(56 189 248 / 0) } 50% { box-shadow: 0 0 0 6px rgb(56 189 248 / .7) } }
        .kds-fresh { animation: kds-fresh 1.2s ease-in-out infinite }
      `}</style>

      {/* Header */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <Link
          href="/admin"
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50"
          aria-label="Back to admin"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          <span className="hidden font-semibold sm:inline">{storeName}</span>
        </Link>

        <nav className="flex flex-wrap gap-1" aria-label="Station">
          {[...KDS_VIEWS, "ready" as const].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                updatePrefs({ screen: s });
                setSelected(0);
              }}
              aria-pressed={prefs.screen === s}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-bold transition-colors",
                prefs.screen === s
                  ? "bg-zinc-50 text-zinc-950"
                  : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800",
              )}
            >
              {s === "ready" ? "Ready" : VIEW_LABEL[s]}
              <span
                className={cn(
                  "min-w-5 rounded px-1 text-xs tabular-nums",
                  prefs.screen === s ? "bg-zinc-950 text-zinc-50" : "bg-zinc-700",
                )}
              >
                {counts[s]}
              </span>
            </button>
          ))}
        </nav>

        <div className="ml-auto flex flex-wrap items-center gap-1">
          <span className="px-2 text-sm text-zinc-400">
            Avg{" "}
            <span className="font-bold text-zinc-50 tabular-nums">
              {snapshot.avgTicketSeconds === null ? "—" : formatElapsed(snapshot.avgTicketSeconds * 1000)}
            </span>
          </span>
          {lateCount > 0 ? (
            <span className="rounded bg-red-600 px-2 py-1 text-sm font-black">{lateCount} late</span>
          ) : null}
          <IconButton
            label={prefs.allDay ? "Hide all-day counts (A)" : "Show all-day counts (A)"}
            active={prefs.allDay}
            onClick={() => updatePrefs({ allDay: !prefs.allDay })}
          >
            <ListOrdered />
          </IconButton>
          <IconButton label="Recall a bumped order (R)" onClick={() => setRecallOpen(true)}>
            <History />
          </IconButton>
          <IconButton
            label={prefs.sound ? "Mute new-order sound" : "Unmute new-order sound"}
            onClick={() => updatePrefs({ sound: !prefs.sound })}
          >
            {prefs.sound ? <Volume2 /> : <VolumeX className="text-red-400" />}
          </IconButton>
          <IconButton
            label="Smaller text"
            onClick={() => updatePrefs({ textSize: Math.max(0, prefs.textSize - 1) })}
          >
            <AArrowDown />
          </IconButton>
          <IconButton
            label="Larger text"
            onClick={() => updatePrefs({ textSize: Math.min(TEXT_SIZES.length - 1, prefs.textSize + 1) })}
          >
            <AArrowUp />
          </IconButton>
          <IconButton
            label="Full screen"
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void document.documentElement.requestFullscreen?.().catch(() => {});
            }}
          >
            <Maximize />
          </IconButton>
          <span className="flex items-center gap-1.5 px-2 text-lg font-bold tabular-nums">
            <span
              className={cn("size-2 rounded-full", stale ? "bg-red-500" : "bg-emerald-400")}
              aria-hidden="true"
            />
            {new Date(screenNow).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </span>
        </div>
      </header>

      {/* Alerts */}
      {stale ? (
        <div role="alert" className="flex shrink-0 items-center gap-2 bg-red-600 px-4 py-2 font-bold">
          <WifiOff className="size-5" aria-hidden="true" />
          Connection lost — showing tickets as of{" "}
          {new Date(lastSync + offsetMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
          . Retrying… Check the wifi or call orders in by phone.
        </div>
      ) : null}
      {cancelAlerts.map((n) => (
        <div
          key={n}
          role="alert"
          className="flex shrink-0 items-center gap-3 bg-red-600 px-4 py-2 text-lg font-black uppercase"
        >
          #{n} was canceled — pull it
          <button
            type="button"
            onClick={() => setCancelAlerts((a) => a.filter((x) => x !== n))}
            className="ml-auto flex items-center gap-1 rounded bg-black/30 px-3 py-1 text-sm"
          >
            <X className="size-4" aria-hidden="true" /> Got it
          </button>
        </div>
      ))}

      {/* Board */}
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto p-3">
          {tickets.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center text-zinc-500">
              <p className="text-3xl font-black text-zinc-300">
                {prefs.screen === "ready" ? "Nothing waiting" : "All caught up"}
              </p>
              <p className="mt-2">
                {prefs.screen === "ready"
                  ? "Bumped orders wait here until they're picked up or out the door."
                  : "New orders appear here the moment they're placed."}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] items-start gap-3">
              {tickets.map((order, i) =>
                prefs.screen === "ready" ? (
                  <ReadyCard
                    key={order.id}
                    order={order}
                    position={i + 1}
                    selected={i === selectedIndex}
                    now={screenNow}
                    onSelect={() => setSelected(i)}
                    onHandoff={() => handoff(order)}
                  />
                ) : (
                  <Ticket
                    key={order.id}
                    order={order}
                    view={view}
                    position={i + 1}
                    selected={i === selectedIndex}
                    fresh={now - (fresh.get(order.id) ?? -Infinity) < FRESH_MS}
                    now={screenNow}
                    timing={snapshot.timing}
                    onSelect={() => setSelected(i)}
                    onTapItem={(item) =>
                      void act({ type: "item", itemId: item.id, stage: tapStage(item, view) })
                    }
                    onBump={() => bump(order)}
                  />
                ),
              )}
            </div>
          )}
        </main>

        {showAllDay ? (
          <aside
            aria-label="All-day counts"
            className="hidden w-60 shrink-0 overflow-y-auto border-l border-zinc-800 p-3 md:block"
          >
            <h2 className="text-xs font-black tracking-widest text-zinc-400 uppercase">
              All day · {VIEW_LABEL[view]}
            </h2>
            {allDayRows.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-500">Nothing waiting to be made.</p>
            ) : (
              <ul className="mt-2 space-y-2" data-testid="kds-all-day">
                {allDayRows.map((r) => (
                  <li key={r.key} className="flex items-start gap-2">
                    <span className="min-w-7 text-right text-2xl leading-none font-black tabular-nums">
                      {r.quantity}
                    </span>
                    <span className="min-w-0 text-sm leading-tight">
                      <span className="block font-bold">{r.name}</span>
                      {r.size ? <span className="text-zinc-400">{r.size}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        ) : null}
      </div>

      {recallOpen ? (
        <RecallPanel
          orders={snapshot.recent}
          now={screenNow}
          onClose={() => setRecallOpen(false)}
          onRecall={(o) => {
            recall(o);
            setRecallOpen(false);
          }}
        />
      ) : null}

      {!started ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/95 p-6">
          <button
            type="button"
            onClick={start}
            data-testid="kds-start"
            className="rounded-2xl bg-emerald-500 px-10 py-8 text-center text-zinc-950 shadow-2xl hover:bg-emerald-400"
          >
            <span className="block text-3xl font-black">Start kitchen display</span>
            <span className="mt-2 block text-base font-semibold">
              Tap once so new orders can chime and the screen stays awake.
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function IconButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex size-10 items-center justify-center rounded-md transition-colors hover:bg-zinc-800 [&_svg]:size-5",
        active ? "bg-zinc-800 text-zinc-50" : "text-zinc-400",
      )}
    >
      {children}
    </button>
  );
}

function ReadyCard({
  order,
  position,
  selected,
  now,
  onSelect,
  onHandoff,
}: {
  order: KdsOrder;
  position: number;
  selected: boolean;
  now: number;
  onSelect: () => void;
  onHandoff: () => void;
}) {
  const waiting = now - Date.parse(order.readyAt ?? order.placedAt);
  return (
    <article
      data-testid={`kds-ready-${order.number}`}
      onPointerDown={onSelect}
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border-2 bg-zinc-900",
        selected ? "border-sky-400 ring-4 ring-sky-400/40" : "border-zinc-700",
      )}
    >
      <header className="bg-emerald-600 px-3 py-2 text-zinc-950">
        <div className="flex items-center gap-2">
          {position <= 9 ? (
            <kbd className="flex size-6 items-center justify-center rounded bg-black/25 text-xs font-bold">
              {position}
            </kbd>
          ) : null}
          <span className="text-xl font-black tabular-nums">#{order.number}</span>
          <TypeChip type={order.type} />
          <span className="ml-auto text-sm font-bold tabular-nums">waiting {formatElapsed(waiting)}</span>
        </div>
        <p className="mt-0.5 truncate text-lg font-black">{order.customerName}</p>
      </header>
      <div className="space-y-1 px-3 py-2 text-sm">
        <p className="text-zinc-300 tabular-nums">{order.customerPhone}</p>
        {order.address ? <p className="font-semibold">{order.address}</p> : null}
        <ul className="pt-1">
          {order.items.map((i) => {
            const { size, crust } = ticketLine(i.modifiers);
            return (
              <li key={i.id} className="py-0.5">
                <span className="font-bold">
                  {i.quantity}× {i.name}
                </span>
                <SizeCrust size={size} crust={crust} />
              </li>
            );
          })}
        </ul>
      </div>
      <button
        type="button"
        onClick={onHandoff}
        data-testid={`kds-handoff-${order.number}`}
        className="m-2 mt-auto h-12 rounded-md bg-zinc-50 text-lg font-black text-zinc-950 uppercase hover:bg-zinc-200"
      >
        {order.type === "delivery" ? "Out for delivery" : "Picked up"}
      </button>
    </article>
  );
}

function RecallPanel({
  orders,
  now,
  onClose,
  onRecall,
}: {
  orders: KdsOrder[];
  now: number;
  onClose: () => void;
  onRecall: (order: KdsOrder) => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60" onClick={onClose}>
      <aside
        role="dialog"
        aria-label="Recall a bumped order"
        className="h-full w-full max-w-md overflow-y-auto border-l border-zinc-800 bg-zinc-900 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-black">Recall</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-zinc-400 hover:bg-zinc-800"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>
        <p className="mt-1 text-sm text-zinc-400">
          Orders bumped in the last two hours. Recalling puts the ticket back on the line from the start.
        </p>
        {orders.length === 0 ? (
          <p className="mt-6 text-zinc-500">Nothing bumped recently.</p>
        ) : (
          <ul className="mt-4 divide-y divide-zinc-800">
            {orders.map((o) => (
              <li key={o.id} className="flex items-center gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-lg font-black tabular-nums">#{o.number}</span>
                    <TypeChip type={o.type} />
                  </span>
                  <span className="block truncate text-sm text-zinc-300">
                    {o.customerName} · bumped {formatElapsed(now - Date.parse(o.readyAt ?? o.placedAt))} ago
                    {o.status === "completed" ? " · handed off" : ""}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => onRecall(o)}
                  data-testid={`kds-recall-${o.number}`}
                  className="h-11 rounded-md bg-amber-400 px-4 font-black text-zinc-950 uppercase hover:bg-amber-300"
                >
                  Recall
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
