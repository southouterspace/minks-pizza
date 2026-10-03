"use client";

import { Check, Flame, MessageSquareWarning } from "lucide-react";
import {
  formatElapsed,
  itemsFor,
  SECTION_LABEL,
  stageOf,
  ticketLine,
  timerLevel,
  type KdsItem,
  type KdsOrder,
  type KdsTiming,
  type KdsView,
  type TicketMod,
  type TimerLevel,
} from "@/lib/kds";
import { fulfillmentLabel, type Fulfillment } from "@/lib/orders";
import { PizzaGlyph } from "@/components/pizza-glyph";
import { cn } from "@/lib/utils";

const HEADER_TONE: Record<TimerLevel, string> = {
  ok: "bg-zinc-800 text-zinc-50",
  warn: "bg-amber-400 text-zinc-950",
  late: "bg-red-600 text-white",
};

const BUMP_LABEL: Record<KdsView, string> = {
  all: "Bump",
  make: "Fire to oven",
  oven: "Out · cut & box",
  kitchen: "Bump kitchen",
};

const CHIP_TONE: Record<Fulfillment["kind"], string> = {
  pickup: "bg-zinc-100 text-zinc-950",
  delivery: "bg-sky-500 text-zinc-950",
  dine_in: "bg-violet-400 text-zinc-950",
};

export function TypeChip({ fulfillment }: { fulfillment: Fulfillment }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[0.7rem] font-extrabold tracking-wider uppercase",
        CHIP_TONE[fulfillment.kind],
      )}
    >
      {fulfillmentLabel(fulfillment)}
    </span>
  );
}

export function SizeCrust({ size, crust }: { size: string | null; crust: string | null }) {
  if (!size && !crust) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1.5">
      {size ? (
        <span className="rounded bg-zinc-50 px-1.5 py-0.5 text-sm font-black text-zinc-950 uppercase">
          {size}
        </span>
      ) : null}
      {crust ? (
        <span className="rounded border-2 border-zinc-50 px-1.5 py-px text-sm font-bold uppercase">
          {crust}
        </span>
      ) : null}
    </span>
  );
}

function OvenClock({ ovenAt, now, ovenMinutes }: { ovenAt: string; now: number; ovenMinutes: number }) {
  const left = Date.parse(ovenAt) + ovenMinutes * 60_000 - now;
  if (left <= 0) {
    return (
      <span className="animate-pulse rounded bg-red-600 px-1.5 py-0.5 text-xs font-black text-white uppercase">
        Pull · {formatElapsed(-left)} over
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-orange-500 px-1.5 py-0.5 text-xs font-black text-zinc-950 uppercase tabular-nums">
      <Flame className="size-3.5" aria-hidden="true" />
      Oven {formatElapsed(left)}
    </span>
  );
}

function ModList({ mods, className }: { mods: TicketMod[]; className?: string }) {
  return (
    <span className={cn("block min-w-0 flex-1 space-y-0.5 text-base leading-snug", className)}>
      {mods.map((m, i) => (
        <span
          key={i}
          className={cn(
            "block",
            m.kind === "remove" && "font-extrabold text-red-400 uppercase",
            m.kind === "amount" && "font-extrabold text-amber-300",
            m.kind === "option" && "text-zinc-300",
          )}
        >
          {m.kind === "add" ? `+ ${m.label}` : m.label}
        </span>
      ))}
    </span>
  );
}

function ItemRow({
  item,
  now,
  timing,
  onTap,
}: {
  item: KdsItem;
  now: number;
  timing: KdsTiming;
  onTap: () => void;
}) {
  const stage = stageOf(item);
  const { size, crust, mods, toppings } = ticketLine(item.modifiers);
  return (
    <li>
      <button
        type="button"
        onClick={onTap}
        disabled={stage === "void"}
        data-testid={`kds-item-${item.id}`}
        data-stage={stage}
        className={cn(
          "w-full px-3 py-2 text-left transition-colors hover:bg-zinc-800/60 active:bg-zinc-800",
          stage === "done" && "opacity-35",
          stage === "void" && "bg-red-950/60 hover:bg-red-950/60",
        )}
      >
        <span className="flex items-start gap-2">
          <span
            className={cn(
              "shrink-0 text-lg leading-tight font-black tabular-nums",
              item.quantity > 1 && "rounded bg-yellow-300 px-1 text-zinc-950",
            )}
          >
            {item.quantity}×
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                "block text-lg leading-tight font-bold",
                (stage === "done" || stage === "void") && "line-through",
              )}
            >
              {stage === "void" ? (
                <span className="mr-1.5 rounded bg-red-600 px-1 text-sm font-black text-white no-underline">
                  VOID
                </span>
              ) : null}
              {item.name}
            </span>
            <SizeCrust size={size} crust={crust} />
            {toppings.length > 0 ? (
              <span className="mt-1.5 block space-y-1" data-testid={`kds-toppings-${item.id}`}>
                {toppings.map((section) => (
                  <span key={section.placement} className="flex items-start gap-2">
                    <span
                      data-placement={section.placement}
                      className="mt-0.5 inline-flex w-20 shrink-0 items-center gap-1 rounded bg-zinc-700 px-1.5 py-0.5 text-xs font-black tracking-wider uppercase"
                    >
                      <PizzaGlyph placement={section.placement} className="size-3.5" />
                      {SECTION_LABEL[section.placement]}
                    </span>
                    <ModList mods={section.mods} />
                  </span>
                ))}
              </span>
            ) : null}
            {mods.length > 0 ? <ModList mods={mods} className="mt-1" /> : null}
            {item.notes ? (
              <span className="mt-1 flex items-start gap-1 rounded bg-yellow-300 px-1.5 py-1 text-sm font-bold text-zinc-950">
                <MessageSquareWarning className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {item.notes}
              </span>
            ) : null}
          </span>
          <span className="shrink-0 pt-0.5">
            {stage === "oven" && item.ovenAt ? (
              <OvenClock ovenAt={item.ovenAt} now={now} ovenMinutes={timing.ovenMinutes} />
            ) : stage === "done" ? (
              <Check className="size-5 text-emerald-400" aria-label="Done" />
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

export function Ticket({
  order,
  view,
  position,
  selected,
  fresh,
  now,
  timing,
  onTapItem,
  onBump,
  onSelect,
}: {
  order: KdsOrder;
  view: KdsView;
  position: number;
  selected: boolean;
  fresh: boolean;
  now: number;
  timing: KdsTiming;
  onTapItem: (item: KdsItem) => void;
  onBump: () => void;
  onSelect: () => void;
}) {
  const age = now - Date.parse(order.placedAt);
  const level = timerLevel(age, timing);
  const items = itemsFor(order, view);
  const kitchenItems = view === "all" ? items.filter((i) => i.station !== "counter") : items;
  const counterItems = view === "all" ? items.filter((i) => i.station === "counter") : [];
  const notStarted = order.status === "new";

  return (
    <article
      data-testid={`kds-ticket-${order.number}`}
      onPointerDown={onSelect}
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border-2 bg-zinc-900 text-zinc-50",
        selected ? "border-sky-400 ring-4 ring-sky-400/40" : "border-zinc-700",
        fresh && "kds-fresh",
      )}
    >
      <header className={cn("px-3 py-2", HEADER_TONE[level])}>
        <div className="flex items-center gap-2">
          {position <= 9 ? (
            <kbd className="flex size-6 items-center justify-center rounded bg-black/25 text-xs font-bold">
              {position}
            </kbd>
          ) : null}
          <span className="text-xl font-black tabular-nums">#{order.number}</span>
          <TypeChip fulfillment={order.fulfillment} />
          <span className="ml-auto text-xl font-black tabular-nums">{formatElapsed(age)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-sm font-semibold">
          <span className="truncate">{order.customerName}</span>
          {notStarted ? (
            <span className="ml-auto rounded bg-black/30 px-1.5 text-[0.7rem] font-black tracking-wider uppercase">
              New
            </span>
          ) : null}
        </div>
      </header>

      {order.notes ? (
        <p className="flex items-start gap-1.5 bg-yellow-300 px-3 py-1.5 text-sm font-bold text-zinc-950">
          <MessageSquareWarning className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {order.notes}
        </p>
      ) : null}

      <ul className="flex-1 divide-y divide-zinc-800">
        {kitchenItems.map((item) => (
          <ItemRow key={item.id} item={item} now={now} timing={timing} onTap={() => onTapItem(item)} />
        ))}
      </ul>

      {counterItems.length > 0 ? (
        <div className="border-t border-dashed border-zinc-700 px-3 py-1.5 text-sm text-zinc-400">
          <span className="font-semibold tracking-wider uppercase">Counter: </span>
          {counterItems.map((i) => `${i.quantity}× ${i.name}`).join(", ")}
        </div>
      ) : null}

      <button
        type="button"
        onClick={onBump}
        data-testid={`kds-bump-${order.number}`}
        className="m-2 h-12 rounded-md bg-emerald-500 text-lg font-black tracking-wide text-zinc-950 uppercase transition-colors hover:bg-emerald-400 active:bg-emerald-600"
      >
        {BUMP_LABEL[view]}
      </button>
    </article>
  );
}
