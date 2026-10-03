import { and, eq, inArray, sql } from "drizzle-orm";
import { adjustments, db, orderItems, orders, tenders } from "@/db";
import {
  dueCents,
  factId,
  hasFact,
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
import { getOpenShift, type Shift } from "@/lib/shifts-server";
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

type Plan = { ok: true; statements: Statement[]; alsoFold?: string } | Failure;

type Ctx = {
  order: OrderView;
  actor: StaffContext["actor"];
  approvedBy: number | null;
  settings: Settings;
  shift: Shift | null;
  now: Date;
};

type ByKind = { [M in OrderMutation as M["kind"]]: M };
type Handlers = { [K in keyof ByKind]: (m: ByKind[K], ctx: Ctx) => Plan | Promise<Plan> };

const ok = (statements: Statement[], alsoFold?: string): Plan => ({ ok: true, statements, alsoFold });
const noOpenShift: Failure = { ok: false, reason: "no_open_shift" };
const notOnOrder = () => rejected("That line is not on this order.");
const liveLine = (o: OrderView, lineId: string) => o.lines.find((l) => l.lineId === lineId && !l.voided);

function adjustment(m: ByKind["discount" | "comp"], cents: number, { order, actor, approvedBy }: Ctx): Plan {
  if (cents <= 0) return rejected("A discount must be more than zero.");
  return ok([
    db
      .insert(adjustments)
      .values({
        id: m.id,
        orderId: order.id,
        lineUid: m.lineId,
        kind: m.kind,
        cents,
        reason: m.reason,
        employeeId: actor.employeeId,
        approvedBy,
      })
      .onConflictDoNothing({ target: adjustments.id }),
  ]);
}

const MUTATIONS: Handlers = {
  add_lines: async (m, { order, settings }) => {
    const priced = await priceLines(m.lines, policyOf(settings));
    if (!Array.isArray(priced)) return priced;
    return ok(insertLines(order.id, priced, m.fire));
  },

  fire: (m, { order }) =>
    ok([
      fireStamp(
        and(eq(orderItems.orderId, order.id), m.lineIds === "all" ? undefined : inArray(orderItems.lineUid, m.lineIds)),
      ),
    ]),

  void_line: (m, { order, actor, approvedBy, now }) => {
    if (!order.lines.some((l) => l.lineId === m.lineId)) return notOnOrder();
    return ok([
      db
        .update(orderItems)
        .set(voidStamp(now, actor.employeeId, m.reason, approvedBy))
        .where(and(eq(orderItems.orderId, order.id), eq(orderItems.lineUid, m.lineId))),
    ]);
  },

  discount: (m, ctx) => {
    if (m.lineId !== null && !liveLine(ctx.order, m.lineId)) return notOnOrder();
    return adjustment(m, m.cents, ctx);
  },

  comp: (m, ctx) => {
    const line = liveLine(ctx.order, m.lineId);
    if (!line) return notOnOrder();
    return adjustment(m, line.lineTotalCents, ctx);
  },

  tender: (m, { order, actor, shift }) => {
    const problem = tenderProblem(m.tender);
    if (problem) return rejected(problem);
    if (m.tender.amountCents > dueCents(order.totals)) return rejected("That is more than the balance due.");
    if (!shift) return noOpenShift;
    return ok([tenderInsert(order.id, m.tender, shift.id, actor.employeeId)]);
  },

  refund: (m, { order, actor, approvedBy, shift }) => {
    const net = order.totals.paidCents - order.totals.refundedCents;
    if (m.amountCents <= 0 || m.amountCents > net) return rejected("A refund can't exceed what was paid.");
    if (!shift) return noOpenShift;
    return ok([
      db
        .insert(tenders)
        .values({
          id: m.id,
          orderId: order.id,
          shiftId: shift.id,
          direction: "refund",
          method: m.method,
          amountCents: m.amountCents,
          employeeId: actor.employeeId,
          approvedBy,
          reason: m.reason,
        })
        .onConflictDoNothing({ target: tenders.id }),
    ]);
  },

  set_customer: (m, { order }) => {
    const c = customerUpsert(m.customer);
    return ok([
      c.statement,
      ...(m.customer.saveAddress ? addressUpsert(c.id, order.fulfillment) : []),
      db
        .update(orders)
        .set({ customerId: c.id, customerName: m.customer.name, customerPhone: m.customer.phone, customerEmail: m.customer.email })
        .where(eq(orders.id, order.id)),
    ]);
  },

  set_fulfillment: (m, { order, settings }) =>
    ok([db.update(orders).set(fulfillmentColumns(m.fulfillment, settings)).where(eq(orders.id, order.id))]),

  set_schedule: (m, { order, now }) => {
    if (order.status !== "held") return rejected("This order is already in the kitchen.");
    const { fireNow, fireAt } = firing(m.fire, now);
    const promisedAt = m.promisedAt ? new Date(m.promisedAt) : null;
    return ok([
      db.update(orders).set({ fireAt, promisedAt: promisedAt ?? sql`${orders.promisedAt}` }).where(eq(orders.id, order.id)),
      ...(fireNow ? [fireStamp(eq(orderItems.orderId, order.id))] : []),
    ]);
  },

  cancel: (m, { order, actor, approvedBy, now }) =>
    ok([
      db
        .update(orderItems)
        .set(voidStamp(now, actor.employeeId, m.reason, approvedBy))
        .where(eq(orderItems.orderId, order.id)),
      db
        .update(orders)
        .set({ status: "canceled", deliveryFeeCents: 0, tipCents: 0, updatedAt: sql`now()` })
        .where(eq(orders.id, order.id)),
    ]),

  split_by_item: (m, { order, actor }) => {
    const moving = new Set(m.lineIds);
    const live = order.lines.filter((l) => !l.voided);
    if (m.lineIds.length === 0 || m.lineIds.some((l) => !liveLine(order, l))) {
      return rejected("Pick lines on this order to split off.");
    }
    if (live.every((l) => moving.has(l.lineId))) return rejected("Leave at least one line on the original check.");
    return ok(
      [
        db.execute(sql`
          insert into orders (id, status, order_type, channel, table_label, customer_id, customer_name,
            customer_phone, customer_email, address_line1, address_line2, city, zip, order_notes,
            created_by, fire_at, promised_at, ticket_order_id, placed_at, tax_rate_bps)
          select ${m.newOrderId}, status, order_type, channel, table_label, customer_id, customer_name,
            customer_phone, customer_email, address_line1, address_line2, city, zip, order_notes,
            ${actor.employeeId}, fire_at, promised_at, coalesce(ticket_order_id, id), placed_at, tax_rate_bps
          from orders where id = ${order.id}
          on conflict (id) do nothing`),
        db
          .update(orderItems)
          .set({ orderId: m.newOrderId })
          .where(and(eq(orderItems.orderId, order.id), inArray(orderItems.lineUid, m.lineIds))),
        db
          .update(adjustments)
          .set({ orderId: m.newOrderId })
          .where(and(eq(adjustments.orderId, order.id), inArray(adjustments.lineUid, m.lineIds))),
      ],
      m.newOrderId,
    );
  },

  handoff: (_m, { order }) => {
    if (order.status !== "ready") return rejected("Only a ready order can be handed off.");
    return ok([
      db
        .update(orders)
        .set({ status: "completed", updatedAt: sql`now()` })
        .where(and(eq(orders.id, order.id), eq(orders.status, "ready"))),
    ]);
  },
};

function plan<K extends keyof ByKind>(m: ByKind[K], ctx: Ctx): Plan | Promise<Plan> {
  const handler: Handlers[K] = MUTATIONS[m.kind as K];
  return handler(m, ctx);
}

async function orderExists(id: string): Promise<boolean> {
  const [row] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, id));
  return row !== undefined;
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
  const m = input.mutation;
  const [order, settings, shift, splitDone] = await Promise.all([
    getOrderView(input.orderId),
    getSettings(),
    getOpenShift(),
    m.kind === "split_by_item" ? orderExists(m.newOrderId) : false,
  ]);
  if (!order) return { ok: false, reason: "not_found" };
  if (order.status === "canceled" && m.kind !== "refund") return rejected("This order is canceled.");

  // A replayed fact must not be judged against the order it already changed
  // (a tender would now exceed the balance due, a split line is gone).
  const fact = factId(m);
  if (fact !== null && (hasFact(order, fact) || splitDone)) return { ok: true, order };

  const auth = await authorize(
    requiredRole(m, { order, discountApprovalCents: settings.discountApprovalCents }),
    staff,
    input.approval,
  );
  if (!auth.ok) return auth;

  const p = await plan(m, { order, actor: staff.actor, approvedBy: auth.approvedBy, settings, shift, now: new Date() });
  if (!p.ok) return p;
  if (p.statements.length > 0) {
    await run([...p.statements, ...folds(order.id), ...(p.alsoFold ? folds(p.alsoFold) : [])]);
  }
  const fresh = await getOrderView(order.id);
  return fresh ? { ok: true, order: fresh } : { ok: false, reason: "not_found" };
}
