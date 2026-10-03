import { and, eq, inArray, sql } from "drizzle-orm";
import { adjustments, db, orderItems, orders, tenders } from "@/db";
import {
  dueCents,
  rejected,
  requiredRole,
  type Approval,
  type Failure,
  type MutationResult,
  type OrderMutation,
  type OrderView,
} from "@/lib/orders";
import { priceLines } from "@/lib/menu-server";
import { authorize } from "@/lib/pin";
import { getSettings, policyOf, type Settings } from "@/lib/settings-server";
import { getOpenShift } from "@/lib/shifts-server";
import type { StaffContext } from "@/lib/staff";
import { fireStamp, folds, run, type Statement } from "./folds";
import { getOrderView } from "./views";
import {
  addressUpsert,
  customerUpsert,
  firing,
  fulfillmentColumns,
  insertLines,
  tenderInsert,
  tenderProblem,
  voidStamp,
} from "./writes";

type Plan = { statements: Statement[]; alsoFold?: string } | Failure;

const liveLine = (o: OrderView, lineId: string) => o.lines.find((l) => l.lineId === lineId && !l.voided);

async function plan(
  m: OrderMutation,
  order: OrderView,
  actor: StaffContext["actor"],
  approvedBy: number | null,
  settings: Settings,
): Promise<Plan> {
  const id = order.id;
  const now = new Date();
  switch (m.kind) {
    case "add_lines": {
      const priced = await priceLines(m.lines, policyOf(settings));
      if (!Array.isArray(priced)) return priced;
      return { statements: insertLines(id, priced, m.fire ? now : null) };
    }
    case "fire":
      return {
        statements: [
          fireStamp(and(eq(orderItems.orderId, id), m.lineIds === "all" ? undefined : inArray(orderItems.lineUid, m.lineIds)), now),
        ],
      };
    case "void_line": {
      if (!order.lines.some((l) => l.lineId === m.lineId)) return rejected("That line is not on this order.");
      return {
        statements: [
          db
            .update(orderItems)
            .set(voidStamp(now, actor.employeeId, m.reason, approvedBy))
            .where(and(eq(orderItems.orderId, id), eq(orderItems.lineUid, m.lineId))),
        ],
      };
    }
    case "discount":
    case "comp": {
      if (order.adjustments.some((a) => a.id === m.id)) return { statements: [] };
      const line = m.lineId === null ? null : liveLine(order, m.lineId);
      if (m.lineId !== null && !line) return rejected("That line is not on this order.");
      const cents = m.kind === "comp" ? line!.lineTotalCents : m.cents;
      if (cents <= 0) return rejected("A discount must be more than zero.");
      return {
        statements: [
          db
            .insert(adjustments)
            .values({
              id: m.id,
              orderId: id,
              lineUid: m.lineId,
              kind: m.kind,
              cents,
              reason: m.reason,
              employeeId: actor.employeeId,
              approvedBy,
            })
            .onConflictDoNothing({ target: adjustments.id }),
        ],
      };
    }
    case "tender": {
      if (order.tenders.some((t) => t.id === m.tender.id)) return { statements: [] };
      const problem = tenderProblem(m.tender);
      if (problem) return rejected(problem);
      if (m.tender.amountCents > dueCents(order.totals)) return rejected("That is more than the balance due.");
      const shift = await getOpenShift();
      if (!shift) return { ok: false, reason: "no_open_shift" };
      return { statements: [tenderInsert(id, m.tender, shift.id, actor.employeeId)] };
    }
    case "refund": {
      if (order.tenders.some((t) => t.id === m.id)) return { statements: [] };
      const net = order.totals.paidCents - order.totals.refundedCents;
      if (m.amountCents <= 0 || m.amountCents > net) return rejected("A refund can't exceed what was paid.");
      const shift = await getOpenShift();
      if (!shift) return { ok: false, reason: "no_open_shift" };
      return {
        statements: [
          db
            .insert(tenders)
            .values({
              id: m.id,
              orderId: id,
              shiftId: shift.id,
              direction: "refund",
              method: m.method,
              amountCents: m.amountCents,
              employeeId: actor.employeeId,
              approvedBy,
              reason: m.reason,
            })
            .onConflictDoNothing({ target: tenders.id }),
        ],
      };
    }
    case "set_customer": {
      const c = customerUpsert(m.customer);
      return {
        statements: [
          c.statement,
          ...(m.customer.saveAddress ? addressUpsert(c.id, order.fulfillment) : []),
          db
            .update(orders)
            .set({ customerId: c.id, customerName: m.customer.name, customerPhone: m.customer.phone, customerEmail: m.customer.email })
            .where(eq(orders.id, id)),
        ],
      };
    }
    case "set_fulfillment":
      return {
        statements: [db.update(orders).set(fulfillmentColumns(m.fulfillment, settings)).where(eq(orders.id, id))],
      };
    case "set_schedule": {
      if (order.status !== "held") return rejected("This order is already in the kitchen.");
      const { firedAt, fireAt } = firing(m.fire, now);
      const promisedAt = m.promisedAt ? new Date(m.promisedAt) : null;
      return {
        statements: [
          db.update(orders).set({ fireAt, promisedAt: promisedAt ?? sql`${orders.promisedAt}` }).where(eq(orders.id, id)),
          ...(firedAt ? [fireStamp(eq(orderItems.orderId, id), firedAt)] : []),
        ],
      };
    }
    case "cancel":
      return {
        statements: [
          db
            .update(orderItems)
            .set(voidStamp(now, actor.employeeId, m.reason, approvedBy))
            .where(eq(orderItems.orderId, id)),
          db
            .update(orders)
            .set({ status: "canceled", deliveryFeeCents: 0, tipCents: 0, updatedAt: sql`now()` })
            .where(eq(orders.id, id)),
        ],
      };
    case "split_by_item": {
      if ((await getOrderView(m.newOrderId)) !== null) return { statements: [] };
      const moving = new Set(m.lineIds);
      const live = order.lines.filter((l) => !l.voided);
      if (m.lineIds.length === 0 || m.lineIds.some((l) => !liveLine(order, l))) {
        return rejected("Pick lines on this order to split off.");
      }
      if (live.every((l) => moving.has(l.lineId))) return rejected("Leave at least one line on the original check.");
      return {
        alsoFold: m.newOrderId,
        statements: [
          db.execute(sql`
            insert into orders (id, status, order_type, channel, table_label, customer_id, customer_name,
              customer_phone, customer_email, address_line1, address_line2, city, zip, order_notes,
              created_by, fire_at, promised_at, ticket_order_id, placed_at, tax_rate_bps)
            select ${m.newOrderId}, status, order_type, channel, table_label, customer_id, customer_name,
              customer_phone, customer_email, address_line1, address_line2, city, zip, order_notes,
              ${actor.employeeId}, fire_at, promised_at, coalesce(ticket_order_id, id), placed_at, tax_rate_bps
            from orders where id = ${id}
            on conflict (id) do nothing`),
          db
            .update(orderItems)
            .set({ orderId: m.newOrderId })
            .where(and(eq(orderItems.orderId, id), inArray(orderItems.lineUid, m.lineIds))),
          db
            .update(adjustments)
            .set({ orderId: m.newOrderId })
            .where(and(eq(adjustments.orderId, id), inArray(adjustments.lineUid, m.lineIds))),
        ],
      };
    }
    case "handoff":
      if (order.status !== "ready") return rejected("Only a ready order can be handed off.");
      return {
        statements: [
          db
            .update(orders)
            .set({ status: "completed", updatedAt: sql`now()` })
            .where(and(eq(orders.id, id), eq(orders.status, "ready"))),
        ],
      };
  }
}

/**
 * Applies one POS verb. The role policy runs here, against the order as it
 * is now; when it needs a manager and the actor isn't one, the result is
 * `needs_manager` and the client resends the same input with `approval`.
 */
export async function mutateOrder(
  input: { orderId: string; mutation: OrderMutation; approval?: Approval },
  staff: StaffContext,
): Promise<MutationResult> {
  const order = await getOrderView(input.orderId);
  if (!order) return { ok: false, reason: "not_found" };
  const m = input.mutation;
  if (order.status === "canceled" && m.kind !== "refund") return rejected("This order is canceled.");

  const settings = await getSettings();
  const auth = await authorize(
    requiredRole(m, { order, discountApprovalCents: settings.discountApprovalCents }),
    staff,
    input.approval,
  );
  if (!auth.ok) return auth;

  const p = await plan(m, order, staff.actor, auth.approvedBy, settings);
  if ("ok" in p) return p;
  if (p.statements.length > 0) {
    await run([...p.statements, ...folds(order.id), ...(p.alsoFold ? folds(p.alsoFold) : [])]);
  }
  const fresh = await getOrderView(order.id);
  return fresh ? { ok: true, order: fresh } : { ok: false, reason: "not_found" };
}
