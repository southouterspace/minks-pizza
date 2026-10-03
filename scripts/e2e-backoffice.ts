/**
 * Back-office e2e against a running dev server and its database: staff
 * management, POS settings, a shift rung through the order seam, the Z
 * report and its CSV exports, and the inbox's Collect link and activity log.
 *
 * Run: E2E_BASE_URL=http://localhost:3001 npx tsx --env-file=.env.local scripts/e2e-backoffice.ts
 * Mutates orders, staff and settings, and closes any open shift: point
 * MINKS_DATABASE_URL at a test branch, not production. Expects the seeded
 * menu, demo staff (manager PIN 1234, cashier PIN 5678) and 8.25% tax.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { chromium, type Page } from "playwright";
import { db, employees, operators, pinAttempts, storeSettings } from "../src/db";
import { submitOrder } from "../src/lib/orders-server/submit";
import { mutateOrder } from "../src/lib/orders-server/mutate";
import { getStoreBasics } from "../src/lib/settings-server";
import { getPosMenu } from "../src/lib/menu-server";
import { closeShift, getOpenShift, openShift, recordDrawerEvent } from "../src/lib/shifts-server";
import type { OrderMutation, OrderView, SubmitOrderRequest } from "../src/lib/orders";
import { pinDigest } from "../src/lib/pin";
import { storeDateOf } from "../src/lib/store-time";
import type { StaffContext } from "../src/lib/staff";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp";
const EMAIL = "backoffice@minks.example";
const PASSWORD = "pizza-test-1234";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

/** RFC 4180: quoted cells may hold commas, quotes and newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      rows.push([...row, cell.replace(/\r$/, "")]);
      row = [];
      cell = "";
    } else cell += ch;
  }
  return rows;
}

async function signIn(page: Page) {
  await db
    .insert(operators)
    .values({ email: EMAIL, name: "Back Office", passwordHash: await bcrypt.hash(PASSWORD, 10) })
    .onConflictDoNothing({ target: operators.email });
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin$/, { timeout: 20_000 });
}

async function settingsFlow(page: Page) {
  const [before] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
  try {
    await page.goto(`${BASE}/admin/settings`, { waitUntil: "networkidle" });
    await page.getByText("Higher half", { exact: true }).click();
    await page.fill('input[name="extraToppingMultiplier"]', "1.5");
    await page.fill('input[name="discountApproval"]', "7.50");
    await page.fill('input[name="ovenCapacityPies"]', "8");
    await page.fill('input[name="makeMinutes"]', "4");
    await page.fill('input[name="posLockSeconds"]', "90");
    await page.selectOption('select[name="timezone"]', "America/Denver");
    await page.click('button:has-text("Save settings")');
    await page.waitForURL(/saved=1/, { timeout: 15_000 });
    const [saved] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
    check(
      "POS settings save through the form",
      [saved.halfToppingRule, saved.extraToppingBps, saved.discountApprovalCents, saved.ovenCapacityPies, saved.makeMinutes, saved.posLockSeconds, saved.timezone],
      ["highest", 15_000, 750, 8, 4, 90, "America/Denver"],
    );
    await page.locator("text=Point of sale").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT_DIR}/bo-settings.png` });

    // The browser enforces min/max; skip it to prove the server does too.
    await page.$eval("form:has(button:has-text('Save settings'))", (f) => f.setAttribute("novalidate", ""));
    await page.fill('input[name="posLockSeconds"]', "5");
    await page.click('button:has-text("Save settings")');
    await page.waitForURL(/error=/, { timeout: 15_000 });
    check("an out-of-range auto-lock is refused", await page.locator("main [role=alert]").innerText(), "Not saved: Auto-lock is at least 15 seconds.");
    const [after] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
    check("and nothing was written", after.posLockSeconds, 90);
  } finally {
    const { halfToppingRule, extraToppingBps, discountApprovalCents, ovenCapacityPies, makeMinutes, posLockSeconds, timezone } = before;
    await db
      .update(storeSettings)
      .set({ halfToppingRule, extraToppingBps, discountApprovalCents, ovenCapacityPies, makeMinutes, posLockSeconds, timezone })
      .where(eq(storeSettings.id, 1));
  }
}

async function freePin(): Promise<string> {
  for (;;) {
    const pin = String(1000 + Math.floor(Math.random() * 9000));
    const [held] = await db.select({ id: employees.id }).from(employees).where(eq(employees.pinDigest, pinDigest(pin)));
    if (!held) return pin;
  }
}

async function staffFlow(page: Page) {
  const name = `Riley Test ${Date.now() % 100_000}`;
  const [pin, newPin] = [await freePin(), await freePin()];
  await page.goto(`${BASE}/admin/team`, { waitUntil: "networkidle" });
  const addForm = page.locator("form:has(button:has-text('Add employee'))");
  const add = async (who: string, role: string, p: string) => {
    await addForm.locator('input[name="name"]').fill(who);
    await addForm.locator('select[name="role"]').selectOption(role);
    await addForm.locator('input[name="pin"]').fill(p);
    await addForm.locator("button[type=submit]").click();
  };

  await add(name, "cashier", pin);
  await page.waitForURL(/notice=staff-added/, { timeout: 15_000 });
  const row = page.locator('[data-testid="employee-row"]', { hasText: name });
  check("new employee is listed as a cashier", await row.locator("[data-slot=badge]").innerText(), "Cashier");
  check(
    "the PIN is not shown back: every PIN field is empty and masked",
    await page.locator('input[name="pin"]').evaluateAll((els) => [...new Set(els.map((e) => `${(e as HTMLInputElement).type}:${(e as HTMLInputElement).value}`))]),
    ["password:"],
  );
  const [created] = await db.select().from(employees).where(eq(employees.name, name));
  check("only the PIN's digest is stored", [created.pinDigest === pinDigest(pin), created.pinDigest.includes(pin)], [true, false]);

  await add("Duplicate Dana", "manager", pin);
  check("a PIN another active employee holds is refused", await addForm.locator("[data-slot=field-error]").innerText(), "That PIN belongs to someone else. Pick another.");
  await add("Duplicate Dana", "manager", "1234");
  check("the demo manager's PIN is refused too", await addForm.locator("[data-slot=field-error]").innerText(), "That PIN belongs to someone else. Pick another.");
  check("a refused add keeps the name and role typed in", [await addForm.locator('input[name="name"]').inputValue(), await addForm.locator('select[name="role"]').inputValue()], ["Duplicate Dana", "manager"]);
  check("no duplicate was written", (await db.select().from(employees).where(eq(employees.name, "Duplicate Dana"))).length, 0);
  await page.screenshot({ path: `${SHOT_DIR}/bo-team.png`, fullPage: true });

  const pinForm = row.locator("form:has(button:has-text('Set PIN'))");
  await pinForm.locator('input[name="pin"]').fill("5678");
  await pinForm.locator("button[type=submit]").click();
  check("changing to a taken PIN is refused", await pinForm.locator("[data-slot=field-error]").innerText(), "That PIN belongs to someone else. Pick another.");
  await pinForm.locator('input[name="pin"]').fill(newPin);
  await pinForm.locator("button[type=submit]").click();
  await page.waitForURL(/notice=pin-changed/, { timeout: 15_000 });
  const [changed] = await db.select().from(employees).where(eq(employees.id, created.id));
  check("Set PIN stores the new PIN's digest", changed.pinDigest, pinDigest(newPin));

  const deactivate = page.locator('[data-testid="employee-row"]', { hasText: name }).getByRole("button", { name: "Deactivate" });
  await deactivate.click();
  await page.locator('[data-testid="employee-row"]', { hasText: name }).getByRole("button", { name: "Confirm deactivate" }).click();
  await page.waitForURL(/notice=staff-deactivated/, { timeout: 15_000 });
  const [gone] = await db.select().from(employees).where(eq(employees.id, created.id));
  check("deactivate keeps the row but turns the PIN off", gone.isActive, false);
  check("a deactivated employee leaves the active list", await page.locator('[data-testid="employee-row"]', { hasText: name }).count(), 0);
  await db.delete(employees).where(eq(employees.id, created.id));

  const morgan = page.locator('[data-testid="employee-row"]', { hasText: "Morgan Manager" });
  try {
    await morgan.getByRole("button", { name: "Deactivate" }).click();
    await morgan.getByRole("button", { name: "Confirm deactivate" }).click();
    await page.waitForURL(/notice=last-approver/, { timeout: 15_000 });
    const [m] = await db.select().from(employees).where(eq(employees.name, "Morgan Manager"));
    check("the last active manager can't be deactivated", m.isActive, true);
  } finally {
    await db.update(employees).set({ isActive: true }).where(eq(employees.name, "Morgan Manager"));
  }
}

/**
 * Rings a shift through the order seam (the POS screens are built
 * elsewhere): two walk-ins paid cash, a phone order paid by card with a tip,
 * a manager-approved void, an unpaid phone order, a paid-out and a no-sale.
 * Medium Cheese is $13.99 and garlic knots $5.99 at 8.25% tax.
 */
async function ringShift() {
  const [operator] = await db.select().from(operators).where(eq(operators.email, EMAIL));
  const staff = await db.select().from(employees);
  const as = (name: string): StaffContext => {
    const e = staff.find((r) => r.name === name && r.isActive);
    if (!e) throw new Error(`missing demo employee ${name}; run npm run db:seed`);
    return { actor: { employeeId: e.id, name: e.name, role: e.role }, operatorId: operator.id };
  };
  const cashier = as("Casey Cashier");
  const manager = as("Morgan Manager");
  await db.delete(pinAttempts).where(eq(pinAttempts.operatorId, operator.id));

  const stale = await getOpenShift();
  if (stale) {
    await closeShift({ shiftId: stale.id, countedCashCents: 0, cardBatchCents: 0, declaredCashTipsCents: 0, notes: "closed by e2e" }, manager);
  }
  const shiftId = randomUUID();
  const opened = await openShift({ shiftId, startingBankCents: 10_000 }, cashier);
  if (!opened.ok) throw new Error(JSON.stringify(opened));

  const items = (await getPosMenu()).categories.flatMap((c) => c.items);
  const item = (name: string) => items.find((i) => i.name === name)!;
  const cheese = item("Cheese Pizza");
  const mod = (name: string) => cheese.groups.flatMap((g) => g.modifiers).find((m) => m.name === name)!.id;
  const pie = () => ({
    lineId: randomUUID(),
    itemId: cheese.id,
    quantity: 1,
    notes: null,
    selections: [mod('Medium 12"'), mod("Hand Tossed")].map((modifierId) => ({ modifierId, placement: "whole" as const, amount: "regular" as const })),
  });
  const knots = () => ({ lineId: randomUUID(), itemId: item("Garlic Knots (6)").id, quantity: 1, notes: null, selections: [] });
  const order = (channel: "walk_in" | "phone", lines: SubmitOrderRequest["lines"], name: string): SubmitOrderRequest => ({
    orderId: randomUUID(),
    channel,
    fulfillment: { kind: "pickup" },
    customer: channel === "phone" ? { phone: "5550104455", name, email: null, saveAddress: false } : null,
    notes: null,
    fire: { kind: "now" },
    promisedAt: null,
    tipCents: 0,
    lines,
    tenders: [],
  });
  const ok = (r: Awaited<ReturnType<typeof submitOrder>>): OrderView => {
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.order;
  };
  const cash = (amountCents: number, tenderedCents: number): OrderMutation => ({
    kind: "tender",
    tender: { id: randomUUID(), method: "cash", amountCents, tenderedCents, tipCents: 0, last4: null },
  });

  const a = ok(await submitOrder(order("walk_in", [pie()], "Walk-in"), { kind: "pos", staff: cashier }));
  ok(await mutateOrder({ orderId: a.id, mutation: cash(1514, 2000) }, cashier));

  const b = ok(await submitOrder(order("phone", [pie(), knots()], "Pat Phone"), { kind: "pos", staff: cashier }));
  ok(
    await mutateOrder(
      { orderId: b.id, mutation: { kind: "tender", tender: { id: randomUUID(), method: "card_external", amountCents: 2163, tenderedCents: null, tipCents: 300, last4: "4242" } } },
      cashier,
    ),
  );

  const knotLine = knots();
  const c = ok(await submitOrder(order("walk_in", [pie(), knotLine], "Walk-in"), { kind: "pos", staff: cashier }));
  const voidKnots: OrderMutation = { kind: "void_line", lineId: knotLine.lineId, reason: "customer changed mind" };
  check("voiding a fired line asks for a manager", await mutateOrder({ orderId: c.id, mutation: voidKnots }, cashier), { ok: false, reason: "needs_manager" });
  ok(await mutateOrder({ orderId: c.id, mutation: voidKnots, approval: { managerPin: "1234" } }, cashier));
  ok(await mutateOrder({ orderId: c.id, mutation: cash(1514, 1514) }, cashier));

  const d = ok(await submitOrder(order("phone", [pie()], "Una Unpaid"), { kind: "pos", staff: cashier }));

  await recordDrawerEvent({ id: randomUUID(), kind: "paid_out", cents: 300, reason: "bag of ice", approval: { managerPin: "1234" } }, cashier);
  await recordDrawerEvent({ id: randomUUID(), kind: "no_sale", cents: 0, reason: "change for a twenty", approval: { managerPin: "1234" } }, cashier);

  const closed = await closeShift(
    { shiftId, countedCashCents: 12_700, cardBatchCents: 2463, declaredCashTipsCents: 1200, notes: null, approval: { managerPin: "1234" } },
    cashier,
  );
  if (!closed.ok) throw new Error(JSON.stringify(closed));
  return { shiftId, paidCash: a, paidCard: b, voided: c, unpaid: d };
}

async function reportsFlow(page: Page, shift: Awaited<ReturnType<typeof ringShift>>) {
  const { timezone } = await getStoreBasics();
  const today = storeDateOf(new Date(), timezone);

  await page.goto(`${BASE}/admin/reports`, { waitUntil: "networkidle" });
  const row = page.locator(`[data-testid="shift-row"][href="/admin/reports/shift/${shift.shiftId}"]`);
  check("the closed shift is listed with its over/short", [await row.locator("[data-testid=shift-cash]").innerText(), await row.locator("[data-testid=shift-card]").innerText()], ["Short $0.28", "Even"]);
  check("and who opened and closed it", await row.locator("[data-testid=shift-people]").innerText(), "Opened by Casey Cashier · closed by Morgan Manager");
  await page.screenshot({ path: `${SHOT_DIR}/bo-reports.png`, fullPage: true });

  await row.click();
  await page.waitForURL(`**/admin/reports/shift/${shift.shiftId}`);
  const doc = page.locator('[data-testid="report-document"]');
  const text = await doc.innerText();
  const has = (label: string, line: string) => check(label, text.includes(line), true);
  has("Z report title", "Z report");
  has("walk-in sales", "Walk-in (2)\n$27.98");
  has("phone sales", "Phone (2)\n$33.97");
  has("net sales", "Net sales (4 orders)\n$61.95");
  has("tax", "Tax\n$5.10");
  has("cash payments", "Payments (2)\n$30.28");
  has("card tips", "Tips\n$3.00");
  has("net card incl. tips", "Net card incl. tips\n$24.63");
  has("paid out in the drawer math", "Paid out\n−$3.00");
  has("expected cash", "Expected cash\n$127.28");
  check("cash over/short", await doc.locator("[data-testid=cash-over-short]").innerText(), "Cash over/short\nShort $0.28");
  check("card total vs the terminal batch", await doc.locator("[data-testid=card-over-short]").innerText(), "Card over/short\nEven");
  has("cash tips declared", "Cash tips declared\n$12.00");
  const voids = await doc.locator("[data-testid=audit-void]").innerText();
  check("void shows the line, who, the approver and the reason", voids.includes(`#${shift.voided.number} 1 × Garlic Knots (6)`) && voids.includes("Casey Cashier, approved by Morgan Manager") && voids.includes("“customer changed mind”"), true);
  const drawer = await doc.locator("[data-testid=audit-no_sale]").innerText();
  check("no-sale lists who opened it and why", drawer.includes("Casey Cashier, approved by Morgan Manager") && drawer.includes("“change for a twenty”"), true);
  has("the unpaid order is listed", `#${shift.unpaid.number} Una Unpaid · New\n$15.14 due`);
  await page.screenshot({ path: `${SHOT_DIR}/bo-zreport-letter.png`, fullPage: true });

  await page.click('a:has-text("80mm receipt")');
  await page.waitForURL(/paper=receipt/);
  await page.emulateMedia({ media: "print" });
  check("receipt layout prints at 80mm (302px at 96 dpi)", Math.round((await doc.boundingBox())!.width), 302);
  check("print hides the admin sidebar", await page.locator("aside").isVisible(), false);
  await page.screenshot({ path: `${SHOT_DIR}/bo-zreport-80mm-print.png`, fullPage: true });
  await page.emulateMedia({ media: "screen" });

  const lines = parseCsv(await (await page.request.get(`${BASE}/api/admin/reports/lines?shift=${shift.shiftId}`)).text());
  check(
    "lines CSV header",
    lines[0],
    ["order_number", "placed_at_local", "channel", "order_type", "status", "customer", "item", "quantity", "unit_price", "line_total", "modifiers", "notes", "voided_at_local", "void_reason", "voided_by", "void_approved_by"],
  );
  const knotsRow = lines.find((l) => l[0] === String(shift.voided.number) && l[6] === "Garlic Knots (6)")!;
  check("lines CSV: the voided knots with price, reason, who and approver", [knotsRow[8], knotsRow[9], ...knotsRow.slice(-3)], ["5.99", "5.99", "customer changed mind", "Casey Cashier", "Morgan Manager"]);
  check("lines CSV: placed time is store-local and sortable", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(knotsRow[1]), true);
  check("lines CSV has every line of the shift's orders", lines.length - 1, 6);
  const tenderCsv = await page.request.get(`${BASE}/api/admin/reports/tenders?shift=${shift.shiftId}`);
  check("tenders CSV downloads as a file", tenderCsv.headers()["content-disposition"]?.startsWith('attachment; filename="minks-tenders-shift-'), true);
  check(
    "tenders CSV: order, direction, method, amount, tip, tendered, change, last4, employee",
    parseCsv(await tenderCsv.text()).slice(1).map((r) => r.slice(1, 10)),
    [
      [String(shift.paidCash.number), "payment", "cash", "15.14", "0", "20", "4.86", "", "Casey Cashier"],
      [String(shift.paidCard.number), "payment", "card_external", "21.63", "3", "", "", "4242", "Casey Cashier"],
      [String(shift.voided.number), "payment", "cash", "15.14", "0", "15.14", "0", "", "Casey Cashier"],
    ],
  );
  const dayCsv = await page.request.get(`${BASE}/api/admin/reports/tenders?date=${today}`);
  check("day tenders CSV includes the shift's tenders", (await dayCsv.text()).includes("4242"), true);
  check("CSV needs an operator session", (await fetch(`${BASE}/api/admin/reports/lines?date=${today}`)).status, 401);

  await page.goto(`${BASE}/admin/reports/day/${today}`, { waitUntil: "networkidle" });
  check("day report renders the same fold", (await doc.innerText()).includes("Day report"), true);
  await page.screenshot({ path: `${SHOT_DIR}/bo-day-report.png`, fullPage: true });
}

async function inboxFlow(page: Page, shift: Awaited<ReturnType<typeof ringShift>>) {
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  const unpaid = page.locator(`[data-testid="order-card"][data-order-number="${shift.unpaid.number}"]`);
  const collect = unpaid.getByRole("link", { name: /Collect/ });
  check("an unpaid order links to the POS to collect", [await collect.innerText(), await collect.getAttribute("href")], ["Collect $15.14 at POS", `/pos?order=${shift.unpaid.id}`]);
  const voided = page.locator(`[data-testid="order-card"][data-order-number="${shift.voided.number}"]`);
  check("a paid order has no Collect link", await voided.getByRole("link", { name: /Collect/ }).count(), 0);
  await voided.locator("[data-testid=order-activity] summary").click();
  const activity = (await voided.locator("[data-testid=order-activity] ol").innerText()).split("\n").map((l) => l.replace(/^\d{1,2}:\d{2} [AP]M\s*/, ""));
  check(
    "Activity shows placed, sent, the approved void and the payment",
    activity,
    [
      "Placed (Walk-in) · Casey Cashier",
      "Sent to kitchen: 1 × Cheese Pizza, 1 × Garlic Knots (6)",
      "Voided 1 × Garlic Knots (6) (customer changed mind) · Casey Cashier, approved by Morgan Manager",
      "Paid 15.14 cash · Casey Cashier",
    ],
  );
  await voided.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOT_DIR}/bo-inbox.png` });
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await signIn(page);
  await staffFlow(page);
  await settingsFlow(page);
  const shift = await ringShift();
  await reportsFlow(page, shift);
  await inboxFlow(page, shift);
  await browser.close();
  console.log(failures === 0 ? "\nBACKOFFICE E2E PASSED" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

