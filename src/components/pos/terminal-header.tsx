"use client";

import { POS_ACCESS_LABEL } from "@/lib/pos-access";
import { Lock, Menu as MenuIcon, Moon, TriangleAlert, WifiOff } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DrawerEventKind } from "@/lib/orders";
import type { OutboxEntry } from "@/lib/pos-outbox";
import { SYNC_STALE_MS } from "@/lib/use-server-snapshot";
import { formatClock } from "@/lib/zoned";
import { cn } from "@/lib/utils";
import { usePos } from "./context";
import { Tap } from "./touch";

export type TerminalDialog = { kind: "open_shift" } | { kind: "close_shift"; shiftId: string } | { kind: "drawer"; drawer: DrawerEventKind } | { kind: "outbox" };

export type TerminalPrefs = { dark: boolean; lockAfterOrder: boolean };

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s ago` : `${Math.round(ms / 60_000)}m ago`);

const tab = (active: boolean) =>
  cn("h-11 rounded-lg px-4 text-base font-medium", active ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground");

export function TerminalHeader({
  draftTab,
  onBoard,
  onDraftTab,
  onBoardTab,
  queue,
  lastSync,
  prefs,
  updatePrefs,
  openDialog,
  lock,
}: {
  draftTab: string;
  onBoard: boolean;
  onDraftTab: () => void;
  onBoardTab: () => void;
  queue: OutboxEntry[];
  lastSync: number;
  prefs: TerminalPrefs;
  updatePrefs: (patch: Partial<TerminalPrefs>) => void;
  openDialog: (d: TerminalDialog) => void;
  lock: () => void;
}) {
  const { board, staff, store, online, now } = usePos();
  const pending = queue.filter((e) => e.state === "pending").length;
  const rejected = queue.length - pending;
  const shift = board.shift;
  const stale = now - lastSync > SYNC_STALE_MS;

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b px-3">
      <span className="hidden text-base font-semibold lg:block">{store.name}</span>
      <nav className="flex gap-1 rounded-xl bg-muted p-1">
        <button type="button" className={tab(!onBoard)} onClick={onDraftTab}>
          {draftTab}
        </button>
        <button type="button" className={tab(onBoard)} onClick={onBoardTab} data-testid="tab-board">
          Open orders <span className="ml-1 rounded-md bg-foreground/10 px-1.5 tabular-nums">{board.openOrders.length}</span>
        </button>
      </nav>

      <button
        type="button"
        onClick={() => openDialog({ kind: "outbox" })}
        data-testid="health"
        className={cn(
          "ml-auto flex h-11 items-center gap-2 rounded-xl px-3 text-sm",
          queue.length > 0
            ? "bg-destructive text-white"
            : !online
              ? "bg-destructive/10 text-destructive"
              : stale
                ? "bg-warning/10 text-warning"
                : "text-muted-foreground hover:bg-muted",
        )}
      >
        {!online ? <WifiOff className="size-4" /> : stale ? <TriangleAlert className="size-4" /> : <span className="size-2.5 rounded-full bg-success" />}
        <span data-testid="sync-status">
          {online ? (stale ? "Sync delayed" : "Online") : "Offline"}
          {stale && ` · last synced ${ago(now - lastSync)}`}
        </span>
        {queue.length > 0 && (
          <b data-testid="not-sent-count">
            · {pending > 0 && `${pending} NOT SENT`}
            {rejected > 0 && `${pending > 0 ? ", " : ""}${rejected} refused`}
          </b>
        )}
      </button>

      {!shift && (
        <Tap variant="outline" className="border-warning text-warning" onClick={() => openDialog({ kind: "open_shift" })}>
          Open shift
        </Tap>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger className="flex h-11 items-center gap-2 rounded-xl px-3 hover:bg-muted" data-testid="staff-menu">
          <span className="text-right leading-tight">
            <span className="block font-semibold">{staff.name}</span>
            <span className="block text-xs text-muted-foreground">{POS_ACCESS_LABEL[staff.access]}</span>
          </span>
          <MenuIcon className="size-5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{shift ? `Shift open since ${formatClock(shift.openedAt, store.timeZone)}` : "No open shift"}</DropdownMenuLabel>
            {shift ? (
              <>
                <DropdownMenuItem onClick={() => openDialog({ kind: "drawer", drawer: "no_sale" })}>Open drawer (no sale)</DropdownMenuItem>
                <DropdownMenuItem onClick={() => openDialog({ kind: "drawer", drawer: "paid_in" })}>Paid in</DropdownMenuItem>
                <DropdownMenuItem onClick={() => openDialog({ kind: "drawer", drawer: "paid_out" })}>Paid out</DropdownMenuItem>
                <DropdownMenuItem onClick={() => openDialog({ kind: "close_shift", shiftId: shift.id })} data-testid="menu-close-shift">
                  Close shift…
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem onClick={() => openDialog({ kind: "open_shift" })}>Open shift…</DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={prefs.lockAfterOrder} onCheckedChange={(v) => updatePrefs({ lockAfterOrder: v })}>
            Lock after each order
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={prefs.dark} onCheckedChange={(v) => updatePrefs({ dark: v })}>
            <Moon className="size-4" /> Dark screen
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Tap variant="secondary" onClick={lock} aria-label="Lock terminal" data-testid="lock">
        <Lock className="size-5" />
      </Tap>
    </header>
  );
}
