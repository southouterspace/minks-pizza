/**
 * The order being rung in at the terminal, before it reaches the server.
 * Pure: a reducer over `Draft`, the local totals, and the mapping to the
 * replayable `SubmitOrderRequest`. Prices come from `priceLine`, the same
 * function the server runs, so the panel never waits on the network.
 */
import type { Address, Channel, FirePlan, Fulfillment, SubmitLine, TenderInput } from "@/lib/orders";
import type { PosMenu, SubmitOrderRequest } from "@/lib/orders-server";
import { ticketLine } from "@/lib/kds";
import { priceLine, type LineModifier, type MenuItem, type PricingPolicy, type Selection } from "@/lib/pricing";
import { taxFromBps } from "@/lib/money";

/** What the cashier picks; maps onto the server's channel × fulfillment. */
export type Mode = "walk_in" | "phone" | "delivery" | "dine_in";

export const MODES: { mode: Mode; label: string; channel: Channel }[] = [
  { mode: "walk_in", label: "Walk-in", channel: "walk_in" },
  { mode: "phone", label: "Phone", channel: "phone" },
  { mode: "delivery", label: "Delivery", channel: "phone" },
  { mode: "dine_in", label: "Dine-in", channel: "walk_in" },
];

export const isPhoneFirst = (mode: Mode) => mode === "phone" || mode === "delivery";

export type DraftLine = SubmitLine & { name: string; unitPriceCents: number; modifiers: LineModifier[] };

/** ASAP fires now; Later fires at (ready time − quote); Hold keeps a dine-in course back. */
export type Schedule = { kind: "asap" } | { kind: "later"; readyAt: string } | { kind: "hold" };

export type Draft = {
  orderId: string;
  mode: Mode;
  /** Adding to an open check instead of ringing a new order. */
  appendTo: { orderId: string; number: number; label: string } | null;
  customer: { phone: string; name: string };
  address: Address;
  table: string;
  schedule: Schedule;
  notes: string;
  lines: DraftLine[];
};

const EMPTY_ADDRESS: Address = { line1: "", line2: null, city: null, zip: "" };

export function emptyDraft(mode: Mode = "walk_in"): Draft {
  return {
    orderId: crypto.randomUUID(),
    mode,
    appendTo: null,
    customer: { phone: "", name: "" },
    address: EMPTY_ADDRESS,
    table: "",
    schedule: { kind: "asap" },
    notes: "",
    lines: [],
  };
}

export function draftLine(
  item: MenuItem,
  selections: Selection[],
  quantity: number,
  notes: string | null,
  policy: PricingPolicy,
  lineId: string = crypto.randomUUID(),
): DraftLine {
  const { unitPriceCents, modifiers } = priceLine(item, selections, policy);
  return { lineId, itemId: item.id, name: item.name, quantity, selections, notes, unitPriceCents, modifiers };
}

export type DraftAction =
  | { type: "mode"; mode: Mode }
  | { type: "customer"; patch: Partial<Draft["customer"]> }
  | { type: "address"; address: Address }
  | { type: "table"; table: string }
  | { type: "schedule"; schedule: Schedule }
  | { type: "notes"; notes: string }
  | { type: "add"; lines: DraftLine[] }
  | { type: "replace"; line: DraftLine }
  | { type: "qty"; lineId: string; delta: number }
  | { type: "repeat"; lineId: string }
  | { type: "remove"; lineId: string }
  | { type: "append_to"; order: NonNullable<Draft["appendTo"]>; mode: Mode }
  | { type: "reset"; mode?: Mode };

export function draftReducer(d: Draft, a: DraftAction): Draft {
  switch (a.type) {
    case "mode":
      return {
        ...d,
        mode: a.mode,
        schedule: a.mode !== "dine_in" && d.schedule.kind === "hold" ? { kind: "asap" } : d.schedule,
      };
    case "customer":
      return { ...d, customer: { ...d.customer, ...a.patch } };
    case "address":
      return { ...d, address: a.address };
    case "table":
      return { ...d, table: a.table };
    case "schedule":
      return { ...d, schedule: a.schedule };
    case "notes":
      return { ...d, notes: a.notes };
    case "add":
      return { ...d, lines: mergeLines(d.lines, a.lines) };
    case "replace":
      return { ...d, lines: d.lines.map((l) => (l.lineId === a.line.lineId ? a.line : l)) };
    case "qty":
      return {
        ...d,
        lines: d.lines.flatMap((l) => {
          if (l.lineId !== a.lineId) return [l];
          const quantity = l.quantity + a.delta;
          return quantity < 1 ? [] : [{ ...l, quantity: Math.min(50, quantity) }];
        }),
      };
    case "repeat": {
      const i = d.lines.findIndex((l) => l.lineId === a.lineId);
      if (i < 0) return d;
      const copy = { ...d.lines[i], lineId: crypto.randomUUID() };
      return { ...d, lines: [...d.lines.slice(0, i + 1), copy, ...d.lines.slice(i + 1)] };
    }
    case "remove":
      return { ...d, lines: d.lines.filter((l) => l.lineId !== a.lineId) };
    case "append_to":
      return { ...emptyDraft(a.mode), appendTo: a.order };
    case "reset":
      return emptyDraft(a.mode ?? d.mode);
  }
}

const sameChoice = (a: DraftLine, b: DraftLine) =>
  a.itemId === b.itemId &&
  a.notes === b.notes &&
  JSON.stringify(a.selections) === JSON.stringify(b.selections);

/** Tapping a plain item twice makes one line of 2, not two lines of 1. */
function mergeLines(lines: DraftLine[], added: DraftLine[]): DraftLine[] {
  const out = [...lines];
  for (const line of added) {
    const i = out.findIndex((l) => l.selections.length === 0 && sameChoice(l, line));
    if (i >= 0) out[i] = { ...out[i], quantity: Math.min(50, out[i].quantity + line.quantity) };
    else out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Totals and readiness
// ---------------------------------------------------------------------------

export type DraftTotals = { subtotalCents: number; taxCents: number; deliveryFeeCents: number; totalCents: number };

export function draftTotals(d: Draft, menu: Pick<PosMenu, "taxRateBps" | "deliveryFeeCents">): DraftTotals {
  const subtotalCents = d.lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const taxCents = taxFromBps(subtotalCents, menu.taxRateBps);
  const deliveryFeeCents = d.mode === "delivery" && !d.appendTo ? menu.deliveryFeeCents : 0;
  return { subtotalCents, taxCents, deliveryFeeCents, totalCents: subtotalCents + taxCents + deliveryFeeCents };
}

const digits = (s: string) => s.replace(/\D/g, "");

/** The first thing stopping this draft from being sent, or null. */
export function draftProblem(d: Draft): string | null {
  if (d.lines.length === 0) return "Add an item first.";
  if (d.appendTo) return null;
  if (isPhoneFirst(d.mode)) {
    if (digits(d.customer.phone).length < 7) return "Enter the caller's phone number.";
    if (!d.customer.name.trim()) return "Enter the caller's name.";
  }
  if (d.mode === "delivery" && (!d.address.line1.trim() || !d.address.zip.trim())) {
    return "Delivery needs a street address and ZIP.";
  }
  if (d.mode === "dine_in" && !d.table.trim()) return "Enter the table.";
  if (d.schedule.kind === "later" && Date.parse(d.schedule.readyAt) <= Date.now()) {
    return "The later time has already passed.";
  }
  return null;
}

export function fulfillmentOf(d: Pick<Draft, "mode" | "address" | "table">): Fulfillment {
  switch (d.mode) {
    case "walk_in":
    case "phone":
      return { kind: "pickup" };
    case "delivery":
      return { kind: "delivery", address: d.address };
    case "dine_in":
      return { kind: "dine_in", table: d.table.trim() };
  }
}

export function firePlan(s: Schedule, quoteMinutes: number): { fire: FirePlan; promisedAt: string | null } {
  switch (s.kind) {
    case "asap":
      return { fire: { kind: "now" }, promisedAt: null };
    case "hold":
      return { fire: { kind: "hold" }, promisedAt: null };
    case "later": {
      const at = new Date(Date.parse(s.readyAt) - quoteMinutes * 60_000).toISOString();
      return { fire: { kind: "at", at }, promisedAt: s.readyAt };
    }
  }
}

export function toSubmitRequest(d: Draft, quoteMinutes: number, tenders: TenderInput[]): SubmitOrderRequest {
  const phone = d.customer.phone.trim();
  return {
    orderId: d.orderId,
    channel: MODES.find((m) => m.mode === d.mode)!.channel,
    fulfillment: fulfillmentOf(d),
    customer:
      digits(phone).length >= 7
        ? { phone, name: d.customer.name.trim() || "Guest", email: null, saveAddress: d.mode === "delivery" }
        : null,
    notes: d.notes.trim() || null,
    ...firePlan(d.schedule, quoteMinutes),
    tipCents: 0,
    lines: d.lines.map(({ lineId, itemId, quantity, selections, notes }) => ({ lineId, itemId, quantity, selections, notes })),
    tenders,
  };
}

// ---------------------------------------------------------------------------
// Line text
// ---------------------------------------------------------------------------

/** `Large 14" · Thin Crust · Pepperoni · L: Mushrooms · R: Red Onions`. */
export function lineSummary(modifiers: LineModifier[]): string {
  const t = ticketLine(modifiers);
  const parts = [t.size, t.crust, ...t.whole.map((m) => m.label)].filter((p): p is string => !!p);
  if (t.left.length) parts.push(`L: ${t.left.map((m) => m.label).join(", ")}`);
  if (t.right.length) parts.push(`R: ${t.right.map((m) => m.label).join(", ")}`);
  return parts.join(" · ");
}

export function findItem(menu: PosMenu, itemId: number): MenuItem | undefined {
  for (const c of menu.categories) {
    const item = c.items.find((i) => i.id === itemId);
    if (item) return item;
  }
  return undefined;
}

export const allItems = (menu: PosMenu): MenuItem[] => menu.categories.flatMap((c) => c.items);
