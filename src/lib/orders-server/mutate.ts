import { and, eq, inArray, sql } from "drizzle-orm";
import { db, orderDiscounts, orderItems, orders, tenders } from "@/db";
import { canComp } from "@/lib/order-workflow";
import type { Actor } from "@/lib/order-writes";
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
import { getOpenShift, type DrawerSession } from "@/lib/drawer-server";
import type { StaffContext } from "@/lib/staff";
import { cancel, complete, fireStamp, folds, run, type Statement } from "./folds";
import { getOrderView } from "./views";
import {
  addressUpsert,
  customerUpsert,
  discountInsert,
  firing,
  fulfillmentColumns,
  insertLines,
  tenderInsert,
  tenderProblem,
  voidStamp,
} from "./writes";

/** An operator acting from the admin: no PIN gate, no drawer, their name on the audit row. */
export type OperatorContext = { operator: { id: number; name: string } };

/** Who is mutating: an employee at the POS terminal, or an operator in the admin. */
export type Mutator = StaffContext | OperatorContext;

export function actorOf(by: Mutator, approvedBy: number | null = null): Actor {
  return "operator" in by
    ? { name: by.operator.name, operatorId: by.operator.id, employeeId: null }
    : { name: by.actor.name, operatorId: null, employeeId: by.actor.employeeId, approvedBy };
}

type Plan = { ok: true; statements: Statement[]; alsoFold?: string } | Failure;

type Ctx = {
  order: OrderView;
  actor: Actor;
  /** The employee at the till, or null for an operator. */
  employeeId: number | null;
  approvedBy: number | null;
  settings: Settings;
  /** Null when no drawer is open; an operator's money is recorded without one. */
  drawer: DrawerSession | null;
  atTill: boolean;
  now: Date;
};

type ByKind = { [M in OrderMutation as M["kind"]]: M };
type Handlers = { [K in keyof ByKind]: (m: ByKind[K], ctx: Ctx) => Plan | Promise<Plan> };

const ok = (statements: Statement[], alsoFold?: string): Plan => ({ ok: true, statements, alsoFold });
const noOpenShift: Failure = { ok: false, reason: "no_open_shift" };
const notOnOrder = () => rejected("That line is not on this order.");
const liveLine = (o: OrderView, lineId: string) => o.lines.find((l) => l.lineId === lineId && !l.voided);

const DISCOUNT_LOCKED = "Discounts can only change while the order is open and nothing has been paid. Refund instead.";

function discountRow(m: ByKind["discount" | "comp"], cents: number, { order, actor }: Ctx): Plan {
  if (cents <= 0) return rejected("A discount must be more than zero.");
  if (!canComp({ status: order.status, paidCents: order.totals.paidCents })) return rejected(DISCOUNT_LOCKED);
  return ok([
    discountInsert({
      uid: m.id,
      orderId: order.id,
      lineUid: m.lineId,
      amountCents: cents,
      label: m.reason,
      promotionId: m.kind === "discount" ? m.promotionId : null,
      actor,
    }),
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

  void_line: (m, { order, employeeId, approvedBy }) => {
    if (!order.lines.some((l) => l.lineId === m.lineId)) return notOnOrder();
    return ok([
      db
        .update(orderItems)
        .set(voidStamp(employeeId, m.reason, approvedBy))
        .where(and(eq(orderItems.orderId, order.id), eq(orderItems.lineUid, m.lineId))),
    ]);
  },

  discount: (m, ctx) => {
    if (m.lineId !== null && !liveLine(ctx.order, m.lineId)) return notOnOrder();
    return discountRow(m, m.cents, ctx);
  },

  comp: (m, ctx) => {
    const line = liveLine(ctx.order, m.lineId);
    if (!line) return notOnOrder();
    return discountRow(m, line.lineTotalCents, ctx);
  },

  remove_discount: (m, { order }) => {
    const row = order.discounts.find((d) => d.id === m.discountId);
    if (!row) return ok([]);
    if (row.source !== "comp") return rejected("Only staff discounts can be removed here.");
    if (!canComp({ status: order.status, paidCents: order.totals.paidCents })) return rejected(DISCOUNT_LOCKED);
    return ok([db.delete(orderDiscounts).where(and(eq(orderDiscounts.id, row.id), eq(orderDiscounts.orderId, order.id)))]);
  },

  tender: (m, { order, employeeId, drawer, atTill }) => {
    const problem = tenderProblem(m.tender);
    if (problem) return rejected(problem);
    if (m.tender.amountCents > dueCents(order.totals)) return rejected("That is more than the balance due.");
    if (atTill && !drawer) return noOpenShift;
    return ok([tenderInsert(order.id, m.tender, drawer?.id ?? null, employeeId)]);
  },

  refund: (m, { order, employeeId, approvedBy, drawer, atTill }) => {
    const net = order.totals.paidCents - order.totals.refundedCents;
    if (m.amountCents <= 0 || m.amountCents > net) return rejected("A refund can't exceed what was paid.");
    if (atTill && !drawer) return noOpenShift;
    return ok([
      db
        .insert(tenders)
        .values({
          id: m.id,
          orderId: order.id,
          drawerSessionId: drawer?.id ?? null,
          direction: "refund",
          method: m.method,
          amountCents: m.amountCents,
          employeeId,
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

  cancel: (m, { order, actor, employeeId, approvedBy }) =>
    ok([
      db
        .update(orderItems)
        .set(voidStamp(employeeId, m.reason, approvedBy))
        .where(eq(orderItems.orderId, order.id)),
      ...cancel(order.id, actor, m.reason),
    ]),

  split_by_item: (m, { order, employeeId }) => {
    const moving = new Set(m.lineIds);
    const live = order.lines.filter((l) => !l.voided);
    if (m.lineIds.length === 0 || m.lineIds.some((l) => !liveLine(order, l))) {
      return rejected("Pick lines on this order to split off.");
    }
    if (live.every((l) => moving.has(l.lineId))) return rejected("Leave at least one line on the original check.");
    return ok(
      [
        db.execute(sql`
          insert into orders (id, status, source, order_type, table_label, customer_id, customer_name,
            customer_phone, customer_email, address_line1, address_line2, city, zip, order_notes,
            created_by, fire_at, promised_at, ticket_order_id, placed_at, tax_rate_bps)
          select ${m.newOrderId}, status, source, order_type, table_label, customer_id, customer_name,
            customer_phone, customer_email, address_line1, address_line2, city, zip, order_notes,
            ${employeeId}, fire_at, promised_at, coalesce(ticket_order_id, id), placed_at, tax_rate_bps
          from orders where id = ${order.id}
          on conflict (id) do nothing`),
        db
          .update(orderItems)
          .set({ orderId: m.newOrderId })
          .where(and(eq(orderItems.orderId, order.id), inArray(orderItems.lineUid, m.lineIds))),
        db
          .update(orderDiscounts)
          .set({ orderId: m.newOrderId })
          .where(and(eq(orderDiscounts.orderId, order.id), inArray(orderDiscounts.lineUid, m.lineIds))),
      ],
      m.newOrderId,
    );
  },

  handoff: (_m, { order, actor }) => {
    if (order.status !== "ready") return rejected("Only a ready order can be handed off.");
    return ok(complete([order.id], actor));
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
 * Applies one order verb. For staff the role policy runs here, against the
 * order as it is now; when it needs a manager and the actor isn't one, the
 * result is `needs_manager` and the client resends the same input with
 * `approval`. An operator passes every gate.
 */
export async function mutateOrder(
  input: { orderId: string; mutation: OrderMutation; approval?: Approval },
  by: Mutator,
): Promise<MutationResult> {
  const m = input.mutation;
  const [order, settings, drawer, splitDone] = await Promise.all([
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

  const auth =
    "operator" in by
      ? { ok: true as const, approvedBy: null }
      : await authorize(requiredRole(m, { order, discountApprovalCents: settings.discountApprovalCents }), by, input.approval);
  if (!auth.ok) return auth;

  const actor = actorOf(by, auth.approvedBy);
  const p = await plan(m, {
    order,
    actor,
    employeeId: actor.employeeId,
    approvedBy: auth.approvedBy,
    settings,
    drawer,
    atTill: !("operator" in by),
    now: new Date(),
  });
  if (!p.ok) return p;
  if (p.statements.length > 0) {
    await run([...p.statements, ...(await folds(order.id, actor)), ...(p.alsoFold ? await folds(p.alsoFold, actor) : [])]);
  }
  const fresh = await getOrderView(order.id);
  return fresh ? { ok: true, order: fresh } : { ok: false, reason: "not_found" };
}
