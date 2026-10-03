/**
 * POS wire API against a running dev server: menu, board, caller lookup and
 * the replayable submit, including the locked-terminal and bad-body paths.
 * There is no PIN pad screen yet, so this signs the operator and staff
 * cookies itself with SESSION_SECRET, in the same format the server mints.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-pos-api.ts
 * Needs an operator row and the demo staff (npm run db:seed). Mutates orders.
 */
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { count, eq } from "drizzle-orm";
import { db, employees, operators, orders } from "../src/db";
import type { PosMenu } from "../src/lib/orders";
import { BASE, check, run } from "./e2e/harness";

const key = new TextEncoder().encode(process.env.SESSION_SECRET);
const sign = (claims: Record<string, unknown>) =>
  new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m").sign(key);

run(async () => {
  const [operator] = await db.select().from(operators).limit(1);
  const [cashier] = await db.select().from(employees).where(eq(employees.posAccess, "cashier")).limit(1);
  if (!operator || !cashier) throw new Error("needs an operator and the demo staff (npm run db:seed)");
  const session = `minks_session=${await sign({ sub: String(operator.id) })}`;
  const staff = `minks_staff=${await sign({ sub: String(cashier.id), op: operator.id })}`;
  const locked = { cookie: session };
  const unlocked = { cookie: `${session}; ${staff}` };

  const menuRes = await fetch(`${BASE}/api/pos/menu`, { headers: locked });
  const menu = (await menuRes.json()) as PosMenu;
  check("menu loads on the operator session alone", menuRes.status, 200);
  check("menu carries the half rule", menu.policy, { halfToppingRule: "average", extraToppingBps: 20_000 });

  const board = await fetch(`${BASE}/api/pos/board`, { headers: locked });
  check("board loads", board.status, 200);
  check("board is refused when signed out", (await fetch(`${BASE}/api/pos/board`)).status, 401);

  check("caller lookup needs a staff PIN", (await fetch(`${BASE}/api/pos/customers?phone=5550102222`, { headers: locked })).status, 401);
  const lookup = await (await fetch(`${BASE}/api/pos/customers?phone=(555)%20010-2222`, { headers: unlocked })).json();
  check("caller lookup finds the customer by any phone format", lookup.customer?.phone, "5550102222");

  const knots = menu.categories.flatMap((c) => c.items).find((i) => i.name === "Garlic Knots (6)")!;
  const orderId = randomUUID();
  const body = JSON.stringify({
    orderId,
    source: "walk_in",
    fulfillment: { kind: "pickup" },
    customer: null,
    notes: null,
    fire: { kind: "now" },
    promisedAt: null,
    lines: [{ lineId: randomUUID(), itemId: knots.id, quantity: 1, selections: [] }],
  });
  const post = (headers: Record<string, string>, payload: string) =>
    fetch(`${BASE}/api/pos/orders`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: payload });

  check("submit is refused on a locked terminal", (await post(locked, body)).status, 401);
  const a = await post(unlocked, body);
  const b = await post(unlocked, body);
  const [ja, jb] = [await a.json(), await b.json()];
  check("submit and its replay both succeed", [a.status, b.status], [200, 200]);
  check("replay returns the same order", jb.order.number, ja.order.number);
  check("knots total with 8.25% tax", ja.order.totals.totalCents, 648);
  const [rows] = await db.select({ n: count() }).from(orders).where(eq(orders.id, orderId));
  check("one row in the database", rows.n, 1);
  const bad = await post(unlocked, "{}");
  check("a malformed body is a 400", bad.status, 400);
});
