"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";

const MUTE_KEY = "minks:admin-chime-muted";

function loadMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveMuted(muted: boolean) {
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // Private mode or storage full: the choice just won't persist.
  }
}

/** A soft two-note bell: the front of house, not a hood fan, is listening. */
function chime(ctx: AudioContext) {
  const start = ctx.currentTime;
  [660, 990].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = start + i * 0.2;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  });
}

/**
 * Chimes and flashes the tab title when a `new` order shows up that this tab
 * hasn't seen. Orders present on first load count as seen. Any tap or key on
 * the page acknowledges the alert.
 */
export function NewOrderAlert({ newOrderIds }: { newOrderIds: string[] }) {
  const [acknowledged, setAcknowledged] = useState(() => new Set(newOrderIds));
  const [muted, setMuted] = useState(false);
  const chimed = useRef(new Set(newOrderIds));
  const audio = useRef<AudioContext | null>(null);

  const unseen = newOrderIds.filter((id) => !acknowledged.has(id));
  const unseenKey = unseen.join(",");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after hydration
    setMuted(loadMuted());
    // Browsers only let audio start after a user gesture; the first tap unlocks it.
    const unlock = () => {
      try {
        audio.current ??= new AudioContext();
        void audio.current.resume();
      } catch {}
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  useEffect(() => {
    const ids = unseenKey ? unseenKey.split(",") : [];
    const arrived = ids.filter((id) => !chimed.current.has(id));
    for (const id of arrived) chimed.current.add(id);
    if (arrived.length === 0 || muted) return;
    try {
      audio.current ??= new AudioContext();
      void audio.current.resume().then(() => chime(audio.current!));
    } catch {
      // No audio device or blocked: the title flash still alerts.
    }
  }, [unseenKey, muted]);

  useEffect(() => {
    const count = unseenKey ? unseenKey.split(",").length : 0;
    if (count === 0) return;
    const base = document.title.replace(/^\(\d+\) New orders?$/, "") || "Orders";
    const alert = `(${count}) New ${count === 1 ? "order" : "orders"}`;
    let tick = 0;
    document.title = alert;
    const timer = setInterval(() => {
      tick++;
      document.title = tick % 4 === 3 ? base : alert;
    }, 500);
    return () => {
      clearInterval(timer);
      document.title = base;
    };
  }, [unseenKey]);

  useEffect(() => {
    if (!unseenKey) return;
    const ack = () => setAcknowledged((prev) => new Set([...prev, ...unseenKey.split(",")]));
    window.addEventListener("pointerdown", ack);
    window.addEventListener("keydown", ack);
    return () => {
      window.removeEventListener("pointerdown", ack);
      window.removeEventListener("keydown", ack);
    };
  }, [unseenKey]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="text-muted-foreground"
      aria-pressed={!muted}
      data-testid="chime-toggle"
      onClick={() => {
        const next = !muted;
        setMuted(next);
        saveMuted(next);
      }}
    >
      {muted ? <BellOff data-icon="inline-start" /> : <Bell data-icon="inline-start" />}
      {muted ? "Chime off" : "Chime on"}
    </Button>
  );
}
