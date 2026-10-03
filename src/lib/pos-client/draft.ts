/**
 * The order being rung in at the terminal, before it reaches the server.
 * Pure: a reducer over `Draft`, the local totals, and the mapping to the
 * replayable `SubmitOrderRequest`. Prices come from `priceLine`, the same
 * function the server runs, so the panel never waits on the network.
 */
import {
  digitsOf,
  type Address,
  type StoreSource,
  type FirePlan,
  type Fulfillment,
  type PosMenu,
  type SubmitLine,
  type SubmitOrderRequest,
  type TenderInput,
} from "@/lib/orders";
import { ticketLine } from "@/lib/kds";
import { priceLine, type LineModifier, type MenuItem, type PricingPolicy, type Selection } from "@/lib/pricing";
import { bpsOf } from "@/lib/money";

/** What the cashier picks; maps onto the server's source × fulfillment. */
export type Mode = "walk_in" | "phone" | "delivery" | "dine_in";

type ModeSpec = {
  label: string;
  /** As in "Pay new phone order". */
  noun: string;
  source: StoreSource;
  fulfillment: Fulfillment["kind"];
  /** The caller's number and name come before the food. */
  phoneFirst: boolean;
  /** A course can be held back for the table. */
  hold: boolean;
  /** The mode the next order starts in: a dine-in floor keeps ringing dine-in. */
  next: Mode;
};

export const MODES: Record<Mode, ModeSpec> = {
  walk_in: { label: "Walk-in", noun: "walk-in", source: "walk_in", fulfillment: "pickup", phoneFirst: false, hold: false, next: "walk_in" },
  phone: { label: "Phone", noun: "phone", source: "phone", fulfillment: "pickup", phoneFirst: true, hold: false, next: "walk_in" },
  delivery: { label: "Delivery", noun: "phone", source: "phone", fulfillment: "delivery", phoneFirst: true, hold: false, next: "walk_in" },
  dine_in: { label: "Dine-in", noun: "dine-in", source: "walk_in", fulfillment: "dine_in", phoneFirst: false, hold: true, next: "dine_in" },
};

const MODE_ORDER: Mode[] = ["walk_in", "phone", "delivery", "dine_in"];

export const MODE_OPTIONS = MODE_ORDER.map((value) => ({ value, label: MODES[value].label }));

export type DraftLine = SubmitLine & { name: string; unitPriceCents: number; modifiers: LineModifier[] };

/** ASAP fires now; Later fires at (ready time − quote); Hold keeps a dine-in course back. */
export type Schedule = { kind: "asap" } | { kind: "later"; readyAt: string } | { kind: "hold" };

export type NewOrderDraft = {
  kind: "new";
  orderId: string;
  mode: Mode;
  customer: { phone: string; name: string };
  address: Address;
  table: string;
  schedule: Schedule;
  notes: string;
  lines: DraftLine[];
};

/** Lines being added to an open check: the check already has its customer, table and schedule. */
export type AppendDraft = {
  kind: "append";
  target: { orderId: string; number: number; label: string };
  lines: DraftLine[];
};

export type Draft = NewOrderDraft | AppendDraft;

const EMPTY_ADDRESS: Address = { line1: "", line2: null, city: null, zip: "" };

export function emptyDraft(mode: Mode = "walk_in"): NewOrderDraft {
  return {
    kind: "new",
    orderId: crypto.randomUUID(),
    mode,
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

/** Edits to the order's own details; a check being added to already has them. */
type DetailAction =
  | { type: "mode"; mode: Mode }
  | { type: "customer"; patch: Partial<NewOrderDraft["customer"]> }
  | { type: "address"; address: Address }
  | { type: "table"; table: string }
  | { type: "schedule"; schedule: Schedule }
  | { type: "notes"; notes: string };

export type DraftAction =
  | DetailAction
  | { type: "add"; lines: DraftLine[] }
  | { type: "replace"; line: DraftLine }
  | { type: "qty"; lineId: string; delta: number }
  | { type: "repeat"; lineId: string }
  | { type: "remove"; lineId: string }
  | { type: "append_to"; target: AppendDraft["target"] }
  /** Done with this draft (sent, or adding abandoned): start the next order. */
  | { type: "next" };

function detailReducer(d: NewOrderDraft, a: DetailAction): NewOrderDraft {
  switch (a.type) {
    case "mode":
      return {
        ...d,
        mode: a.mode,
        schedule: !MODES[a.mode].hold && d.schedule.kind === "hold" ? { kind: "asap" } : d.schedule,
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
  }
}

export function draftReducer(d: Draft, a: DraftAction): Draft {
  switch (a.type) {
    case "mode":
    case "customer":
    case "address":
    case "table":
    case "schedule":
    case "notes":
      return d.kind === "new" ? detailReducer(d, a) : d;
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
      return { kind: "append", target: a.target, lines: [] };
    case "next":
      return emptyDraft(d.kind === "new" ? MODES[d.mode].next : "walk_in");
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
  const taxCents = bpsOf(subtotalCents, menu.taxRateBps);
  // An added line rides on the check's existing fee.
  const deliveryFeeCents = d.kind === "new" && MODES[d.mode].fulfillment === "delivery" ? menu.deliveryFeeCents : 0;
  return { subtotalCents, taxCents, deliveryFeeCents, totalCents: subtotalCents + taxCents + deliveryFeeCents };
}

/** The first thing stopping this draft from being sent, or null. */
export function draftProblem(d: Draft): string | null {
  if (d.lines.length === 0) return "Add an item first.";
  if (d.kind === "append") return null;
  const mode = MODES[d.mode];
  if (mode.phoneFirst) {
    if (digitsOf(d.customer.phone).length < 7) return "Enter the caller's phone number.";
    if (!d.customer.name.trim()) return "Enter the caller's name.";
  }
  if (mode.fulfillment === "delivery" && (!d.address.line1.trim() || !d.address.zip.trim())) {
    return "Delivery needs a street address and ZIP.";
  }
  if (mode.fulfillment === "dine_in" && !d.table.trim()) return "Enter the table.";
  if (d.schedule.kind === "later" && Date.parse(d.schedule.readyAt) <= Date.now()) {
    return "The later time has already passed.";
  }
  return null;
}

export function fulfillmentOf(d: Pick<NewOrderDraft, "mode" | "address" | "table">): Fulfillment {
  switch (MODES[d.mode].fulfillment) {
    case "pickup":
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

export const toSubmitLine = ({ lineId, itemId, quantity, selections, notes }: DraftLine): SubmitLine => ({ lineId, itemId, quantity, selections, notes });

export function toSubmitRequest(d: NewOrderDraft, quoteMinutes: number, tenders: TenderInput[]): SubmitOrderRequest {
  const phone = d.customer.phone.trim();
  const mode = MODES[d.mode];
  return {
    orderId: d.orderId,
    source: mode.source,
    fulfillment: fulfillmentOf(d),
    customer:
      digitsOf(phone).length >= 7
        ? { phone, name: d.customer.name.trim() || "Guest", email: null, saveAddress: mode.fulfillment === "delivery" }
        : null,
    notes: d.notes.trim() || null,
    ...firePlan(d.schedule, quoteMinutes),
    tipCents: 0,
    lines: d.lines.map(toSubmitLine),
    tenders,
  };
}

// ---------------------------------------------------------------------------
// Line text
// ---------------------------------------------------------------------------

/** `Large 14" · Thin Crust · Pepperoni · L: Mushrooms · R: Red Onions`. */
export function lineSummary(modifiers: LineModifier[]): string {
  const t = ticketLine(modifiers);
  const section = (p: "whole" | "left" | "right") => t.toppings.find((s) => s.placement === p)?.mods ?? [];
  const parts = [t.size, t.crust, ...section("whole").map((m) => m.label), ...t.mods.map((m) => m.label)].filter(
    (p): p is string => !!p,
  );
  if (section("left").length) parts.push(`L: ${section("left").map((m) => m.label).join(", ")}`);
  if (section("right").length) parts.push(`R: ${section("right").map((m) => m.label).join(", ")}`);
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
