"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import type { Actor, Board, PosMenu } from "@/lib/orders";
import { draftReducer, emptyDraft } from "@/lib/pos-client/draft";
import { usePersistentPrefs } from "@/lib/use-persistent-prefs";
import { useServerSnapshot } from "@/lib/use-server-snapshot";
import type { StoreInfo } from "./context";
import { useOutboxQueue } from "./outbox-ui";
import { LockScreen } from "./pin-pad";
import { usePrinter } from "./print";
import { usePosSession } from "./session";
import type { TerminalPrefs } from "./terminal-header";
import { POLL_MS, UnlockedTerminal, withFreshOrder, type Pane } from "./unlocked-terminal";

const MENU_POLL_MS = 60_000;
const PREFS_KEY = "minks:pos-prefs";
const DEFAULT_PREFS: TerminalPrefs = { dark: false, lockAfterOrder: false };

/** The cached menu, swapped when the server's version moves. Entry never waits on the network. */
function useMenu(initial: PosMenu): PosMenu {
  const [menu, setMenu] = useState(initial);
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await fetch("/api/pos/menu", { cache: "no-store" });
        if (!res.ok) return;
        const m = (await res.json()) as PosMenu;
        setMenu((cur) => (cur.version === m.version ? cur : m));
      } catch {
        // Keep the cached menu.
      }
    }, MENU_POLL_MS);
    return () => clearInterval(t);
  }, []);
  return menu;
}

/**
 * The counter terminal: the lock screen, or the terminal for whoever
 * unlocked it. The board, menu, outbox, draft and screen live here, so they
 * carry over a lock.
 */
export function PosTerminal({
  initialMenu,
  initialBoard,
  initialStaff,
  store,
  lockSeconds,
  names,
  deepLinkOrderId,
}: {
  initialMenu: PosMenu;
  initialBoard: Board;
  initialStaff: Actor | null;
  store: StoreInfo;
  lockSeconds: number;
  names: Record<number, string>;
  deepLinkOrderId: string | null;
}) {
  const menu = useMenu(initialMenu);
  const { queue, drain } = useOutboxQueue();
  const [pane, setPane] = useState<Pane>({ kind: "menu" });
  const sync = useServerSnapshot<Board>("/api/pos/board", initialBoard, {
    intervalMs: POLL_MS,
    onSnapshot: (b) => {
      setPane((p) => withFreshOrder(p, b));
      void drain();
    },
  });
  const [draft, dispatch] = useReducer(draftReducer, undefined, () => emptyDraft());
  const [prefs, updatePrefs] = usePersistentPrefs(PREFS_KEY, DEFAULT_PREFS);
  const { print, portal } = usePrinter();
  const [askForShift, setAskForShift] = useState(false);
  const [deepLink, setDeepLink] = useState(deepLinkOrderId);
  const onDeepLinkOpened = useCallback(() => setDeepLink(null), []);
  const session = usePosSession(initialStaff, lockSeconds, () => {
    setAskForShift(!sync.data.shift);
    void drain();
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", prefs.dark);
  }, [prefs.dark]);

  return (
    <>
      {session.staff ? (
        <UnlockedTerminal
          staff={session.staff}
          lock={session.lock}
          kept={{ menu, sync, queue, draft, dispatch, pane, setPane, prefs, updatePrefs, print }}
          store={store}
          names={names}
          askForShift={askForShift}
          deepLink={deepLink}
          onDeepLinkOpened={onDeepLinkOpened}
        />
      ) : (
        <LockScreen storeName={store.name} timeZone={store.timeZone} lastName={session.lastName} onPin={session.unlock} />
      )}
      {portal}
    </>
  );
}
