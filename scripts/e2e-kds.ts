/**
 * Kitchen display e2e against a running dev server and its database:
 * orders placed through the storefront checkout action → make line → oven → kitchen
 * → ready shelf → handoff, plus recall, undo, cancel alerts, live arrival
 * and bump-bar keys. Asserts both what the screen shows and what the
 * database recorded (the customer tracker reads the same status).
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-kds.ts
 * Mutates orders — point MINKS_DATABASE_URL at a test branch, not production.
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, employees, operators, orderItems, orders, storeSettings } from "../src/db";
import { submitOrder } from "../src/lib/orders-server/submit";
import { mutateOrder } from "../src/lib/orders-server/mutate";
import { placeOrder } from "../src/app/(store)/actions";
import { check, eventually, launchBrowser, menuLookup, run, SHOT_DIR, signIn } from "./harness";

/** Places an online order through the storefront's checkout action. */
async function createOrder(o: {
  customerName: string;
  customerPhone: string;
  delivery?: { addressLine1: string; city: string; zip: string };
  notes?: string;
  lines: { itemId: number; quantity: number; modifierIds: number[]; notes?: string }[];
}) {
  const result = await placeOrder({
    orderType: o.delivery ? "delivery" : "pickup",
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    ...o.delivery,
    orderNotes: o.notes,
    tipCents: 0,
    lines: o.lines,
  });
  if (!result.ok) throw new Error(`order rejected: ${result.error}`);
  return { id: result.orderId, orderNumber: (await orderRow(result.orderId)).orderNumber };
}

const KITCHEN = { email: "kitchen@minks.example", password: "pizza-test-1234", name: "Kitchen" };

const statusIs = (id: string, status: string) =>
  eventually(async () => (await orderRow(id)).status === status);

async function orderRow(id: string) {
  const [o] = await db.select().from(orders).where(eq(orders.id, id));
  return o;
}

async function placeOrders() {
  const { item, pick } = await menuLookup();

  const base = { customerPhone: "(555) 010-2222" } as const;
  const a = await createOrder({
    ...base,
    customerName: "Alice Pickup",
    lines: [
      {
        itemId: item("Cheese Pizza"),
        quantity: 2,
        modifierIds: [pick("Size", 'Large 14"'), pick("Crust", "Thin Crust"), pick("Extra Toppings", "Pepperoni")],
        notes: "well done",
      },
      { itemId: item("Garlic Knots (6)"), quantity: 1, modifierIds: [] },
      { itemId: item("Soda (2-Liter)"), quantity: 1, modifierIds: [] },
    ],
  });
  const b = await createOrder({
    ...base,
    delivery: { addressLine1: "1 Main St", city: "The Woodlands", zip: "77354" },
    customerName: "Bob Delivery",
    notes: "Peanut allergy",
    lines: [
      {
        itemId: item("Margherita"),
        quantity: 1,
        modifierIds: [pick("Size", 'Medium 12"'), pick("Crust", "Hand Tossed")],
      },
    ],
  });
  return { a, b, item, pick };
}

run(async () => {
  // Clear the line so ticket positions are predictable.
  await db.update(orders).set({ status: "completed" }).where(eq(orders.status, "new"));
  await db.update(orders).set({ status: "completed" }).where(eq(orders.status, "preparing"));
  await db.update(orders).set({ status: "completed" }).where(eq(orders.status, "ready"));

  const { a, b, item, pick } = await placeOrders();
  const aItems = await db.select().from(orderItems).where(eq(orderItems.orderId, a.id));
  check(
    "checkout snapshots each line's kitchen station",
    aItems.map((i) => [i.itemName, i.station]).sort(),
    [["Cheese Pizza", "pizza"], ["Garlic Knots (6)", "kitchen"], ["Soda (2-Liter)", "counter"]],
  );
  const pizza = aItems.find((i) => i.itemName === "Cheese Pizza");
  if (!pizza) throw new Error("order A has no pizza line");

  const browser = await launchBrowser();
  // Neither the server's zone (UTC) nor the store's, so a wrong zone shows.
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, timezoneId: "Asia/Tokyo" });
  const shot = (name: string) => page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
  const tab = (name: string) => page.getByRole("button", { name: new RegExp(`^${name}\\s*\\d+$`) });
  const ticketA = page.getByTestId(`kds-ticket-${a.orderNumber}`);
  const ticketB = page.getByTestId(`kds-ticket-${b.orderNumber}`);
  /** A reload renders the server's snapshot, not the optimistic one. */
  const reloadServerSnapshot = async () => {
    await page.reload({ waitUntil: "networkidle" });
    await page.getByTestId("kds-start").click();
  };

  await signIn(page, KITCHEN, "/kitchen");
  await page.getByTestId("kds-start").click();
  await tab("All").click();

  await ticketA.waitFor();
  check("ticket A on the All screen", await ticketA.isVisible(), true);
  const [{ timezone: tz }] = await db.select({ timezone: storeSettings.timezone }).from(storeSettings).where(eq(storeSettings.id, 1));
  const clock = await page.getByTestId("kds-clock").innerText();
  const storeClock = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  check(
    "KDS clock reads the store's time",
    [Date.now(), Date.now() - 60_000].some((t) => storeClock.format(t) === clock.trim()),
    true,
  );
  check("ticket B on the All screen", await ticketB.isVisible(), true);
  const aText = await ticketA.innerText();
  check(
    "ticket shows size, crust, topping, item note and counter row",
    /LARGE 14"/i.test(aText) &&
      /THIN CRUST/i.test(aText) &&
      aText.includes("+ Pepperoni") &&
      aText.includes("well done") &&
      /Counter:\s*1× Soda/i.test(aText),
    true,
  );
  check("order note shown on ticket B", (await ticketB.innerText()).includes("Peanut allergy"), true);
  check("delivery badge on ticket B", /DELIVERY/i.test(await ticketB.innerText()), true);
  const allDay = await page.getByTestId("kds-all-day").innerText();
  check("all-day counts the two large cheese pies", /2\s*Cheese Pizza\s*Large 14"/.test(allDay), true);
  await shot("kds-1-all");

  await tab("Make line").click();
  check("make line shows only pizza items", (await ticketA.innerText()).includes("Garlic Knots"), false);
  await page.getByTestId(`kds-item-${pizza.id}`).click();
  await ticketA.waitFor({ state: "detached", timeout: 5_000 });
  check("fired ticket leaves the make line", await ticketA.count(), 0);
  await eventually(async () => (await db.select().from(orderItems).where(eq(orderItems.id, pizza.id)))[0].ovenAt !== null);
  const fired = (await db.select().from(orderItems).where(eq(orderItems.id, pizza.id)))[0];
  check("pie has an oven time in the database", [fired.ovenAt !== null, fired.doneAt], [true, null]);
  check("order moved to preparing (customer tracker)", await statusIs(a.id, "preparing"), true);

  await tab("Oven").click();
  await ticketA.waitFor();
  check("oven screen shows a bake countdown", /OVEN \d+:\d\d/i.test(await ticketA.innerText()), true);
  await shot("kds-2-oven");
  await page.getByTestId(`kds-bump-${a.orderNumber}`).click();
  await ticketA.waitFor({ state: "detached", timeout: 5_000 });
  check("order waits on the kitchen after the pies are out", (await orderRow(a.id)).status, "preparing");

  await tab("Kitchen").click();
  await ticketA.waitFor();
  await page.getByTestId(`kds-bump-${a.orderNumber}`).click();
  await ticketA.waitFor({ state: "detached", timeout: 5_000 });
  check("kitchen bump makes the order ready", await statusIs(a.id, "ready"), true);
  check("ready time recorded", (await orderRow(a.id)).readyAt !== null, true);

  await tab("Ready").click();
  const readyCard = page.getByTestId(`kds-ready-${a.orderNumber}`);
  await readyCard.waitFor();
  await shot("kds-3-ready");
  await page.getByTestId(`kds-handoff-${a.orderNumber}`).click();
  await readyCard.waitFor({ state: "detached", timeout: 5_000 });
  check("handoff completes the order", await statusIs(a.id, "completed"), true);

  await page.keyboard.press("r");
  await page.getByTestId(`kds-recall-${a.orderNumber}`).click();
  await statusIs(a.id, "preparing");
  const recalled = await orderRow(a.id);
  const recalledItems = await db.select().from(orderItems).where(eq(orderItems.orderId, a.id));
  check(
    "recall puts the order back on the line from scratch",
    [recalled.status, recalled.readyAt, recalledItems.flatMap((i) => [i.ovenAt, i.doneAt]).every((t) => t === null)],
    ["preparing", null, true],
  );

  await tab("All").click();
  await ticketB.waitFor();
  await page.getByTestId(`kds-bump-${b.orderNumber}`).click();
  await ticketB.waitFor({ state: "detached", timeout: 5_000 });
  check("All-screen bump makes the order ready", await statusIs(b.id, "ready"), true);
  await page.getByRole("button", { name: "Undo" }).first().click();
  await ticketB.waitFor({ timeout: 5_000 });
  check("Undo brings the bumped ticket back", await statusIs(b.id, "preparing"), true);

  // Ticket A is first (oldest), B second. "2" selects B, Enter bumps it.
  await page.keyboard.press("2");
  await page.keyboard.press("Enter");
  await ticketB.waitFor({ state: "detached", timeout: 5_000 });
  check("bump-bar keys (2, Enter) bump the second ticket", await statusIs(b.id, "ready"), true);

  const c = await createOrder({
    customerName: "Carol Late",
    customerPhone: "(555) 010-3333",
    lines: [{ itemId: item("Cheese Pizza"), quantity: 1, modifierIds: [pick("Size", 'Small 10"'), pick("Crust", "Hand Tossed")] }],
  });
  const ticketC = page.getByTestId(`kds-ticket-${c.orderNumber}`);
  await ticketC.waitFor({ timeout: 10_000 });
  check("a new order appears without a reload", await ticketC.isVisible(), true);
  check("new ticket flashes", ((await ticketC.getAttribute("class")) ?? "").includes("kds-fresh"), true);

  await db.update(orders).set({ status: "canceled", updatedAt: new Date() }).where(eq(orders.id, c.id));
  const alert = page.getByText(`#${c.orderNumber} was canceled`, { exact: false });
  await alert.waitFor({ timeout: 10_000 });
  check("canceling an on-screen order raises an alert", await alert.isVisible(), true);
  await shot("kds-4-cancel-alert");

  const [operator] = await db.select().from(operators).limit(1);
  const [manager] = await db.select().from(employees).where(eq(employees.role, "manager")).limit(1);
  const staff = {
    operatorId: operator.id,
    actor: { employeeId: manager.id, name: manager.name, role: manager.role },
  };
  const counterLine = (itemId: number, selections: { modifierId: number; placement: "whole" | "left" | "right" }[]) => ({
    lineId: randomUUID(),
    itemId,
    quantity: 1,
    notes: null,
    selections: selections.map((x) => ({ ...x, amount: "regular" as const })),
  });
  const pie = counterLine(item("Cheese Pizza"), [
    { modifierId: pick("Size", 'Large 14"'), placement: "whole" },
    { modifierId: pick("Crust", "Hand Tossed"), placement: "whole" },
    { modifierId: pick("Extra Toppings", "Pepperoni"), placement: "left" },
    { modifierId: pick("Extra Toppings", "Mushrooms"), placement: "right" },
  ]);
  const wings = counterLine(item("Chicken Wings (8)"), [{ modifierId: pick("Sauce", "BBQ"), placement: "whole" }]);
  const counterOrder = (fire: { kind: "now" } | { kind: "at"; at: string }, lines: ReturnType<typeof counterLine>[]) =>
    submitOrder(
      {
        orderId: randomUUID(),
        channel: "phone",
        fulfillment: { kind: "pickup" },
        customer: { name: "Dana Phone", phone: "(555) 010-4444", email: null, saveAddress: false },
        notes: null,
        fire,
        promisedAt: null,
        tipCents: 0,
        lines,
        tenders: [],
      },
      { kind: "pos", staff },
    );
  const d = await counterOrder({ kind: "now" }, [pie, wings]);
  const later = await counterOrder({ kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() }, [
    counterLine(item("Cheese Pizza"), [
      { modifierId: pick("Size", 'Small 10"'), placement: "whole" },
      { modifierId: pick("Crust", "Hand Tossed"), placement: "whole" },
    ]),
  ]);
  if (!d.ok || !later.ok) throw new Error("counter orders rejected");
  const ticketD = page.getByTestId(`kds-ticket-${d.order.number}`);
  await ticketD.waitFor({ timeout: 10_000 });
  const left = await ticketD.getByTestId("kds-half-left").innerText();
  const right = await ticketD.getByTestId("kds-half-right").innerText();
  check("half toppings print in LEFT and RIGHT blocks", [left, right].map((t) => t.replace(/\s+/g, " ")), ["LEFT HALF + Pepperoni", "RIGHT HALF + Mushrooms"]);
  await reloadServerSnapshot();
  await ticketD.waitFor();
  check("a scheduled order stays off the line", await page.getByTestId(`kds-ticket-${later.order.number}`).count(), 0);
  const wingsId = (await db.select().from(orderItems).where(eq(orderItems.lineUid, wings.lineId)))[0].id;
  const voided = await mutateOrder({ orderId: d.order.id, mutation: { kind: "void_line", lineId: wings.lineId, reason: "changed mind" } }, staff);
  check("manager voids a sent line", voided.ok, true);
  const wingsRow = page.getByTestId(`kds-item-${wingsId}`);
  check(
    "voided line stays on the ticket, struck and marked VOID",
    await eventually(async () => (await wingsRow.getAttribute("data-stage")) === "void"),
    true,
  );
  check("VOID label shown", (await wingsRow.innerText()).includes("VOID"), true);
  await shot("kds-4b-halves-void");

  const knots = counterLine(item("Garlic Knots (6)"), []);
  const table = await submitOrder(
    {
      orderId: randomUUID(),
      channel: "walk_in",
      fulfillment: { kind: "dine_in", table: "12" },
      customer: null,
      notes: null,
      fire: { kind: "now" },
      promisedAt: null,
      tipCents: 0,
      lines: [
        counterLine(item("Margherita"), [
          { modifierId: pick("Size", 'Medium 12"'), placement: "whole" },
          { modifierId: pick("Crust", "Hand Tossed"), placement: "whole" },
        ]),
        knots,
      ],
      tenders: [],
    },
    { kind: "pos", staff },
  );
  if (!table.ok) throw new Error(`dine-in order rejected: ${JSON.stringify(table)}`);
  const childId = randomUUID();
  const split = await mutateOrder({ orderId: table.order.id, mutation: { kind: "split_by_item", lineIds: [knots.lineId], newOrderId: childId } }, staff);
  if (!split.ok) throw new Error(`split rejected: ${JSON.stringify(split)}`);
  const childNumber = (await orderRow(childId)).orderNumber;
  await page.getByTestId(`kds-ticket-${table.order.number}`).waitFor({ timeout: 10_000 });
  check("a split table is one ticket on the line", await page.getByTestId(`kds-ticket-${childNumber}`).count(), 0);
  await page.getByTestId(`kds-bump-${table.order.number}`).click();
  check("bumping the split table readies both checks", [await statusIs(table.order.id, "ready"), await statusIs(childId, "ready")], [true, true]);
  await reloadServerSnapshot();
  await tab("Ready").click();
  await page.getByTestId(`kds-ready-${table.order.number}`).waitFor({ timeout: 10_000 });
  check(
    "a split table is one card on the ready shelf",
    [await page.getByTestId(`kds-ready-${table.order.number}`).count(), await page.getByTestId(`kds-ready-${childNumber}`).count()],
    [1, 0],
  );
  await page.getByTestId(`kds-handoff-${table.order.number}`).click();
  check("handing off the card completes both checks", [await statusIs(table.order.id, "completed"), await statusIs(childId, "completed")], [true, true]);
  await page.keyboard.press("r");
  await page.getByTestId(`kds-recall-${table.order.number}`).waitFor({ timeout: 10_000 });
  check("the recall list shows the split table once", await page.getByTestId(`kds-recall-${childNumber}`).count(), 0);
  await page.keyboard.press("Escape");
  await tab("All").click();

  await page.context().setOffline(true);
  const banner = page.getByText("Connection lost", { exact: false });
  await banner.waitFor({ timeout: 25_000 });
  check("offline banner after sync stops", await banner.isVisible(), true);
  check("tickets stay on screen while offline", await ticketA.isVisible(), true);
  await shot("kds-5-offline");
  await page.context().setOffline(false);
  await banner.waitFor({ state: "detached", timeout: 15_000 });
  check("banner clears when the connection returns", await banner.count(), 0);

  await browser.close();
});
