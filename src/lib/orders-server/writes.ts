/** Statement builders shared by submitOrder, mutateOrder and marketplace ingestion. */
import { sql, type SQL } from "drizzle-orm";
import { customerAddresses, customers, db, orderDiscounts, orderEvents, orderItems, tenders } from "@/db";
import type { Actor } from "@/lib/order-writes";
import { normalizePhone, type CustomerInput, type FirePlan, type Fulfillment, type TenderInput } from "@/lib/orders";
import type { PricedLine } from "@/lib/menu-server";
import type { Settings } from "@/lib/settings-server";
import type { Statement } from "./folds";

export function insertLines(orderId: string, lines: PricedLine[], fire: boolean): Statement[] {
  if (lines.length === 0) return [];
  return [
    db
      .insert(orderItems)
      .values(
        lines.map((l) => ({
          lineUid: l.lineId,
          orderId,
          menuItemId: l.itemId,
          itemName: l.name,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          lineTotalCents: l.unitPriceCents * l.quantity,
          modifiers: l.modifiers,
          notes: l.notes,
          station: l.station,
          isAlcoholic: l.isAlcoholic,
          firedAt: fire ? sql`now()` : null,
        })),
      )
      .onConflictDoNothing({ target: orderItems.lineUid }),
  ];
}

/** The "placed" audit row: the first line of every order's history. */
export function placedEvent(orderId: string, actor: Actor): Statement {
  return db.insert(orderEvents).values({
    orderId,
    type: "placed",
    actor: actor.name,
    operatorId: actor.operatorId,
    employeeId: actor.employeeId,
  });
}

export function customerUpsert(c: CustomerInput): { statement: Statement; id: SQL } {
  const phone = normalizePhone(c.phone);
  return {
    statement: db
      .insert(customers)
      .values({ phone, name: c.name, email: c.email, lastOrderAt: sql`now()` })
      .onConflictDoUpdate({
        target: customers.phone,
        set: {
          name: sql`excluded.name`,
          email: sql`coalesce(excluded.email, ${customers.email})`,
          lastOrderAt: sql`now()`,
        },
      }),
    id: sql`(select id from customers where phone = ${phone})`,
  };
}

export function addressUpsert(customerId: SQL, f: Fulfillment): Statement[] {
  if (f.kind !== "delivery") return [];
  const a = f.address;
  return [
    db
      .insert(customerAddresses)
      .values({ customerId, line1: a.line1, line2: a.line2, city: a.city, zip: a.zip })
      .onConflictDoUpdate({
        target: [customerAddresses.customerId, customerAddresses.line1, customerAddresses.zip],
        set: { line2: sql`excluded.line2`, city: sql`excluded.city`, lastUsedAt: sql`now()` },
      }),
  ];
}

export function fulfillmentColumns(f: Fulfillment, s: Pick<Settings, "deliveryFeeCents">) {
  switch (f.kind) {
    case "pickup":
      return { orderType: f.kind, addressLine1: null, addressLine2: null, city: null, zip: null, tableLabel: null, deliveryFeeCents: 0 };
    case "delivery":
      return {
        orderType: f.kind,
        addressLine1: f.address.line1,
        addressLine2: f.address.line2,
        city: f.address.city,
        zip: f.address.zip,
        tableLabel: null,
        deliveryFeeCents: s.deliveryFeeCents,
      };
    case "dine_in":
      return { orderType: f.kind, addressLine1: null, addressLine2: null, city: null, zip: null, tableLabel: f.table, deliveryFeeCents: 0 };
  }
}

/** Null drawer and employee for money not taken at a till: an admin's record, a marketplace's collection. */
export function tenderInsert(
  orderId: string,
  t: TenderInput,
  drawerSessionId: string | null,
  employeeId: number | null,
): Statement {
  return db
    .insert(tenders)
    .values({
      id: t.id,
      orderId,
      drawerSessionId,
      direction: "payment",
      method: t.method,
      amountCents: t.amountCents,
      tenderedCents: t.method === "cash" ? (t.tenderedCents ?? t.amountCents) : null,
      tipCents: t.tipCents,
      last4: t.last4,
      employeeId,
    })
    .onConflictDoNothing({ target: tenders.id });
}

export function tenderProblem(t: TenderInput): string | null {
  if (t.amountCents <= 0) return "A payment must be more than zero.";
  if (t.method === "cash" && t.tenderedCents !== null && t.tenderedCents < t.amountCents) {
    return "Cash handed over is less than the amount applied.";
  }
  return null;
}

/** A staff comp or discount: one order_discounts row the fold caps at what it applies to. */
export function discountInsert(args: {
  uid: string;
  orderId: string;
  lineUid: string | null;
  amountCents: number;
  label: string;
  /** An operator applying a deal by hand from the admin; counts as a use of it. */
  promotionId?: number | null;
  actor: Actor;
}): Statement {
  return db
    .insert(orderDiscounts)
    .values({
      uid: args.uid,
      orderId: args.orderId,
      lineUid: args.lineUid,
      promotionId: args.promotionId ?? null,
      label: args.label,
      amountCents: args.amountCents,
      target: "items",
      source: "comp",
      operatorId: args.actor.operatorId,
      employeeId: args.actor.employeeId,
      approvedBy: args.actor.approvedBy ?? null,
    })
    .onConflictDoNothing({ target: orderDiscounts.uid });
}

/** When a fire plan sends lines to the kitchen, and when a held order fires itself. */
export function firing(plan: FirePlan, now: Date): { fireNow: boolean; fireAt: Date | null } {
  switch (plan.kind) {
    case "now":
      return { fireNow: true, fireAt: null };
    case "hold":
      return { fireNow: false, fireAt: null };
    case "at": {
      const at = new Date(plan.at);
      return at <= now ? { fireNow: true, fireAt: null } : { fireNow: false, fireAt: at };
    }
  }
}

/**
 * Void columns for a line; a line voided twice keeps its first void. Stamped
 * by the database clock like fired_at, so the activity log never shows a
 * void before the send it follows.
 */
export function voidStamp(by: number | null, reason: string, approvedBy: number | null) {
  return {
    voidedAt: sql`coalesce(${orderItems.voidedAt}, now())`,
    voidedBy: sql`coalesce(${orderItems.voidedBy}, ${by})`,
    voidReason: sql`coalesce(${orderItems.voidReason}, ${reason})`,
    voidApprovedBy: sql`coalesce(${orderItems.voidApprovedBy}, ${approvedBy})`,
  };
}
