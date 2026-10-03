/**
 * Staff scheduling and time clock e2e against a running dev server and its
 * database: add an employee with two roles and a PIN, schedule and publish a
 * shift, clock in / break / clock out on the kiosk, fix the punch on the
 * timesheet (audited), approve, export CSV, request and approve time off,
 * and prove a double clock-in leaves one open punch. Asserts both the screen
 * and the database.
 *
 * Run: npx tsx --env-file=.env.local scripts/e2e-timeclock.ts (screenshots go to E2E_SHOT_DIR)
 * Mutates staff tables — point MINKS_DATABASE_URL at a test branch, not production.
 */
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import bcrypt from "bcryptjs";
import { chromium, type Page } from "playwright";
import { and, eq, inArray, isNull, like } from "drizzle-orm";
import {
  db,
  employees,
  operators,
  shifts,
  storeSettings,
  timeEntries,
  timeEntryAudit,
  timeOffRequests,
} from "../src/db";
import { addDays, hhmmOf, localDateOf, weekStartOf, zonedInstant } from "../src/lib/zoned";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp/timeclock-shots";
const EMAIL = "timeclock@minks.example";
const PASSWORD = "pizza-test-1234";
const NAME = "E2E Dana Rivera";
const PIN = "4826";
const TZ = "America/New_York";

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passes++;
  else failures++;
}

/** Writes land a moment after the screen updates; poll the database instead of reading once. */
async function eventually(fn: () => Promise<boolean>, ms = 8_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fn();
}

const pinDigest = (pin: string) =>
  createHmac("sha256", process.env.SESSION_SECRET!).update(`pin:${pin}`).digest("hex");

async function resetStaffData() {
  const old = await db.select({ id: employees.id }).from(employees).where(like(employees.name, "E2E %"));
  const ids = old.map((e) => e.id);
  if (ids.length > 0) {
    await db.delete(timeEntries).where(inArray(timeEntries.employeeId, ids));
    await db.delete(shifts).where(inArray(shifts.employeeId, ids));
    await db.delete(employees).where(inArray(employees.id, ids));
  }
  await db
    .update(storeSettings)
    .set({ timezone: TZ, weekStartsOn: 1, earlyClockInMinutes: null, otDailyMinutes: null, dtDailyMinutes: null })
    .where(eq(storeSettings.id, 1));
  await db.delete(operators).where(eq(operators.email, EMAIL));
  await db.insert(operators).values({ email: EMAIL, name: "Timeclock Tester", passwordHash: await bcrypt.hash(PASSWORD, 10) });
}

async function signIn(page: Page) {
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin$/);
}

async function employeeByName(name: string) {
  return db.query.employees.findFirst({ where: eq(employees.name, name), with: { roles: true } });
}

async function addEmployee(page: Page, name: string, pin: string) {
  await page.goto(`${BASE}/admin/staff/employees/new`, { waitUntil: "networkidle" });
  await page.fill('input[name="name"]', name);
  await page.getByRole("checkbox", { name: "Pizza maker" }).click();
  await page.fill('input[name="rate-pizza_maker"]', "16.00");
  await page.getByRole("checkbox", { name: "Driver" }).click();
  await page.fill('input[name="rate-driver"]', "12.50");
  await page.locator('input[name="primaryRole"][value="pizza_maker"]').check();
  await page.fill('input[name="pin"]', pin);
  await page.getByTestId("employee-save").click();
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  await resetStaffData();

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--force-prefers-reduced-motion"],
  });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const shot = (p: Page, name: string) => p.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
  await signIn(page);

  await addEmployee(page, NAME, PIN);
  await page.getByTestId("employee-created").waitFor();
  const dana = await employeeByName(NAME);
  check(
    "employee saved with two roles, rates and a hashed PIN",
    dana !== undefined &&
      dana.pinDigest === pinDigest(PIN) &&
      JSON.stringify(dana.roles.map((r) => [r.role, r.hourlyRateCents, r.isPrimary]).sort()) ===
        JSON.stringify([["driver", 1250, false], ["pizza_maker", 1600, true]]),
    JSON.stringify(dana?.roles.map((r) => [r.role, r.hourlyRateCents, r.isPrimary])),
  );
  check("PIN is shown once after save", (await page.getByTestId("pin-notice").innerText()).includes(PIN));

  await addEmployee(page, "E2E Sam Duplicate", PIN);
  const dupError = page.getByText("Someone else already has that PIN. Pick another.");
  await dupError.waitFor({ timeout: 8_000 }).catch(() => {});
  check("duplicate PIN is refused with a friendly error", await dupError.isVisible());
  check("duplicate PIN created no employee", (await employeeByName("E2E Sam Duplicate")) === undefined);

  if (!dana) throw new Error("employee missing");
  const today = localDateOf(new Date(), TZ);
  const weekStart = weekStartOf(today, 1);
  const tomorrow = addDays(today, 1);

  // Start half an hour ago (never before midnight) so the punch matches it.
  const nowMinutes = Number(hhmmOf(new Date(), TZ).slice(0, 2)) * 60 + Number(hhmmOf(new Date(), TZ).slice(3));
  const startMinutes = Math.max(0, nowMinutes - 30);
  const hhmm = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  await page.goto(`${BASE}/admin/staff/schedule`, { waitUntil: "networkidle" });
  await page.getByTestId(`add-shift-${dana.id}-${today}`).click();
  const form = page.getByTestId("shift-form");
  await form.waitFor();
  check("shift dialog limits roles to the employee's roles", (await form.locator('select[name="role"] option').count()) === 2);
  await form.locator('select[name="role"]').selectOption("pizza_maker");
  await form.locator('input[name="start"]').fill(hhmm(startMinutes));
  await form.locator('input[name="end"]').fill(hhmm(startMinutes + 300));
  await form.locator('input[name="unpaidBreakMinutes"]').fill("30");
  await page.getByTestId("shift-save").click();
  await form.waitFor({ state: "detached" });
  const cell = page.getByTestId(`schedule-cell-${dana.id}-${today}`);
  await cell.getByTestId("shift-chip").waitFor();
  check("draft shift chip shows in today's cell", (await cell.getByTestId("shift-chip").innerText()).includes("Draft"));
  const [draft] = await db.select().from(shifts).where(eq(shifts.employeeId, dana.id));
  check(
    "shift saved as a draft with role and break",
    draft?.publishedAt === null && draft.role === "pizza_maker" && draft.unpaidBreakMinutes === 30 &&
      draft.endsAt.getTime() - draft.startsAt.getTime() === 300 * 60_000,
  );
  await page.getByTestId("publish-week").click();
  await page.getByText(/Published 1 shift/).waitFor();
  check(
    "publish stamps published_at",
    await eventually(async () => (await db.select().from(shifts).where(eq(shifts.id, draft.id)))[0]?.publishedAt !== null),
  );
  check("chip loses its draft styling", !(await cell.getByTestId("shift-chip").innerText()).includes("Draft"));
  await shot(page, "schedule-desktop");

  const kiosk = await context.newPage();
  await kiosk.goto(`${BASE}/timeclock`, { waitUntil: "networkidle" });
  const typePin = async (pin: string) => {
    for (const d of pin) await kiosk.getByTestId(`tc-key-${d}`).click();
    await kiosk.getByTestId("tc-enter").click();
  };
  const openEntry = () =>
    db.query.timeEntries.findFirst({
      where: and(eq(timeEntries.employeeId, dana.id), isNull(timeEntries.clockOutAt)),
      with: { breaks: true },
    });
  await shot(kiosk, "kiosk-pad");

  await typePin("1111");
  await kiosk.getByText("PIN not recognized.").waitFor();
  check("wrong PIN is rejected on the pad", await kiosk.getByTestId("tc-pad-error").isVisible());

  await kiosk.keyboard.type(PIN);
  await kiosk.keyboard.press("Enter");
  await kiosk.getByTestId("tc-employee").waitFor();
  check("PIN typed on a keyboard opens the employee view", (await kiosk.getByTestId("tc-state").innerText()) === "You're off the clock.");
  check(
    "role picker defaults to the scheduled shift's role",
    (await kiosk.getByRole("radio", { checked: true }).innerText()) === "Pizza maker",
  );
  check("today's published shift is listed", (await kiosk.getByTestId("tc-employee").innerText()).includes("Pizza maker"));
  await shot(kiosk, "kiosk-employee");
  await kiosk.getByTestId("tc-clock-in").click();
  const message = await kiosk.getByTestId("tc-message").innerText();
  check("clock-in confirmation names the time and role", /^Clocked in \d{1,2}:\d{2} [AP]M as Pizza maker$/.test(message), message);
  const opened = await eventually(async () => (await openEntry()) !== undefined);
  const entry = await openEntry();
  check(
    "clock-in opens one punch linked to the shift at the role's rate",
    opened && entry?.shiftId === draft.id && entry.role === "pizza_maker" && entry.hourlyRateCents === 1600 && entry.source === "kiosk",
  );
  await shot(kiosk, "kiosk-confirmation");
  await kiosk.getByTestId("tc-confirmation").click();
  await kiosk.getByTestId("tc-enter").waitFor();

  await typePin(PIN);
  await kiosk.getByTestId("tc-break-unpaid").click();
  await kiosk.getByTestId("tc-message").waitFor();
  check("meal break opens an unpaid break", await eventually(async () => (await openEntry())?.breaks.some((b) => b.endedAt === null && !b.paid) ?? false));
  await kiosk.getByTestId("tc-confirmation").click();

  await typePin(PIN);
  check("clock out is not offered on a break", (await kiosk.getByTestId("tc-clock-out").count()) === 0);
  await kiosk.getByTestId("tc-end-break").click();
  await kiosk.getByTestId("tc-message").waitFor();
  check("end break closes it", await eventually(async () => (await openEntry())?.breaks.every((b) => b.endedAt !== null) ?? false));
  await kiosk.getByTestId("tc-confirmation").click();

  await typePin(PIN);
  await kiosk.getByTestId("tc-clock-out").click();
  await kiosk.getByTestId("tc-tips").fill("12.50");
  await kiosk.getByTestId("tc-confirm-clock-out").click();
  await kiosk.getByTestId("tc-summary").waitFor();
  check("clock-out shows the shift summary with tips", (await kiosk.getByTestId("tc-summary").innerText()).includes("$12.50"));
  const closed = await eventually(async () => (await openEntry()) === undefined);
  const [punch] = await db.select().from(timeEntries).where(eq(timeEntries.employeeId, dana.id));
  check("clock-out closes the punch with declared tips", closed && punch?.clockOutAt !== null && punch.declaredTipsCents === 1250);
  await kiosk.waitForTimeout(4_500);
  check("confirmation returns to the PIN pad on its own", await kiosk.getByTestId("tc-enter").isVisible());

  const danaRow = () => page.getByTestId("timesheet-row").filter({ hasText: NAME });
  const openRow = async () => {
    await page.goto(`${BASE}/admin/staff/timesheets?week=${weekStart}`, { waitUntil: "networkidle" });
    await danaRow().locator("summary").click();
  };
  await openRow();
  check("timesheet lists the kiosk punch", (await danaRow().getByTestId("timesheet-entry").count()) === 1);
  check("unapproved week says so", (await danaRow().getByTestId("timesheet-status").innerText()) === "Needs approval");
  await danaRow().getByTestId("approve-employee").click();
  await page.getByText(/Approved 1 punch/).waitFor();
  const entryRow = async () => (await db.select().from(timeEntries).where(eq(timeEntries.id, punch.id)))[0];
  check("approving stamps the punch", (await entryRow())?.approvedAt !== null);

  const inLocal = hhmmOf(punch.clockInAt, TZ);
  const inMinutes = Math.max(0, Number(inLocal.slice(0, 2)) * 60 + Number(inLocal.slice(3)) - 180);
  const outLocal = hhmmOf(new Date(), TZ);
  const outMinutes = Number(outLocal.slice(0, 2)) * 60 + Number(outLocal.slice(3));
  await openRow();
  await danaRow().getByTestId("edit-punch").click();
  const punchForm = page.getByTestId("punch-form");
  await punchForm.waitFor();
  await punchForm.locator('input[name="clockIn"]').fill(`${today}T${hhmm(inMinutes)}`);
  await punchForm.locator('input[name="clockOut"]').fill(`${today}T${hhmm(outMinutes)}`);
  // The kiosk break lasted seconds; drop it so the expected hours are exact.
  await punchForm.getByRole("button", { name: "Remove break 1" }).click();
  await punchForm.locator('input[name="reason"]').fill("Forgot to clock in on time");
  await page.getByTestId("punch-save").click();
  await punchForm.waitFor({ state: "detached" });
  const audits = await eventually(async () =>
    (await db.select().from(timeEntryAudit).where(eq(timeEntryAudit.timeEntryId, punch.id))).some((a) => a.action === "edit"),
  );
  const auditRows = await db.select().from(timeEntryAudit).where(eq(timeEntryAudit.timeEntryId, punch.id));
  const edited = await entryRow();
  check(
    "edit writes an audit row with the reason and before/after",
    audits &&
      auditRows.some((a) => a.action === "edit" && a.reason === "Forgot to clock in on time" && a.before !== null && a.after !== null),
    JSON.stringify(auditRows.map((a) => a.action)),
  );
  check("editing an approved punch clears approval (audited)", edited?.approvedAt === null && auditRows.some((a) => a.action === "unapprove"));
  check(
    "edited times are saved in the store's timezone",
    hhmmOf(edited!.clockInAt, TZ) === hhmm(inMinutes) && hhmmOf(edited!.clockOutAt!, TZ) === hhmm(outMinutes),
  );
  await openRow();
  check(
    "audit history shows under the entry",
    (await danaRow().getByTestId("audit-history").innerText()).includes("Edited by Timeclock Tester: Forgot to clock in on time"),
  );
  check("edited punch is flagged", (await danaRow().getByTestId("timesheet-entry").innerText()).includes("Edited"));
  await shot(page, "timesheets");
  await page.getByTestId("approve-all").click();
  await page.getByText(/Approved \d+ punch/).waitFor();
  check("approve all approves the edited punch", (await entryRow())?.approvedAt !== null);

  const csv = await page.request.get(`${BASE}/api/admin/timesheets?week=${weekStart}`);
  const body = await csv.text();
  const expectedHours = ((outMinutes - inMinutes) / 60).toFixed(2);
  const entryLine = body.split("\r\n").find((l) => l.startsWith(`entry,${NAME},`));
  const totalLine = body.split("\r\n").find((l) => l.startsWith(`total,${NAME},`));
  check("CSV downloads as an attachment", (csv.headers()["content-disposition"] ?? "").startsWith("attachment;"));
  check(
    "CSV has the punch line with paid hours, rate and tips",
    entryLine?.split(",").slice(2).join(",").startsWith(`Pizza maker,${today},`) === true &&
      entryLine.includes(`,0,${expectedHours},16.00,12.50,`),
    entryLine,
  );
  const grossExpected = ((Math.round((outMinutes - inMinutes) * 1600 / 60)) / 100).toFixed(2);
  check("CSV has the employee summary line", totalLine?.endsWith(`,${expectedHours},0.00,0.00,${grossExpected}`) === true, totalLine);

  await typePin(PIN);
  await kiosk.getByTestId("tc-request-time-off").click();
  await kiosk.getByTestId("tc-off-start").fill(tomorrow);
  await kiosk.getByTestId("tc-off-end").fill(addDays(tomorrow, 1));
  await kiosk.getByTestId("tc-off-reason").fill("Family visit");
  await kiosk.getByTestId("tc-off-submit").click();
  check("kiosk confirms the time-off request", (await kiosk.getByTestId("tc-message").innerText()).startsWith("Time off requested for"));
  const offRows = () => db.select().from(timeOffRequests).where(eq(timeOffRequests.employeeId, dana.id));
  check(
    "request is stored pending from the kiosk",
    await eventually(async () => {
      const [r] = await offRows();
      return r?.status === "pending" && r.source === "kiosk" && r.startDate === tomorrow && r.endDate === addDays(tomorrow, 1);
    }),
  );
  await kiosk.getByTestId("tc-confirmation").click();

  await page.goto(`${BASE}/admin/staff/time-off`, { waitUntil: "networkidle" });
  const pendingRow = page.getByTestId("time-off-pending").filter({ hasText: NAME });
  check("pending request shows reason and dates", (await pendingRow.innerText()).includes("Family visit"));
  await pendingRow.getByTestId("approve-time-off").click();
  await pendingRow.waitFor({ state: "detached" });
  check("approving records the decision", (await offRows())[0]?.status === "approved" && (await offRows())[0]?.decidedBy !== null);
  check("approved time off is listed as upcoming", (await page.getByTestId("time-off-upcoming").innerText()).includes(NAME));

  await page.goto(`${BASE}/admin/staff/schedule?week=${tomorrow}`, { waitUntil: "networkidle" });
  const offCell = page.getByTestId(`schedule-cell-${dana.id}-${tomorrow}`);
  check(
    "schedule cell shows the approved time off",
    (await offCell.getByTestId("time-off-label").innerText()) === "Time off: Family visit",
  );

  await typePin(PIN);
  check("kiosk lists the approved time off", (await kiosk.getByTestId("tc-time-off-list").innerText()).toLowerCase().includes("approved"));
  await kiosk.getByTestId("tc-done").click();

  const clockIn = () =>
    page.request.post(`${BASE}/api/timeclock`, { data: { pin: PIN, action: { type: "clock_in", role: "driver" } } });
  const answers = await Promise.all([clockIn(), clockIn()]);
  const messages = await Promise.all(answers.map(async (r) => (await r.json()).message as string));
  const open = await db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.employeeId, dana.id), isNull(timeEntries.clockOutAt)));
  check("double clock-in leaves exactly one open punch", open.length === 1, JSON.stringify(messages));
  check(
    "the second request answers with the current view, not an error",
    answers.every((r) => r.status() === 200) && messages.includes("You're already clocked in."),
  );
  const backstop = await db
    .insert(timeEntries)
    .values({ employeeId: dana.id, role: "driver", hourlyRateCents: 1250, clockInAt: new Date(), source: "manager" })
    .then(
      () => "inserted",
      (e: { cause?: { code?: string } }) => e.cause?.code ?? "other error",
    );
  check("the database itself refuses a second open punch", backstop === "23505", backstop);
  const unknown = await page.request.post(`${BASE}/api/timeclock`, { data: { pin: "0000" } });
  check("API answers an unknown PIN with 401", unknown.status() === 401);

  await page.goto(`${BASE}/admin/staff`, { waitUntil: "networkidle" });
  const onClock = page.getByTestId("on-clock-row").filter({ hasText: NAME });
  check("overview shows who is on the clock", (await onClock.innerText()).includes("Driver"));
  await shot(page, "overview");
  await onClock.locator('input[name="reason"]').fill("Left without clocking out");
  await onClock.getByRole("button", { name: "Clock out" }).click();
  await onClock.waitFor({ state: "detached" });
  const managerClosed = await eventually(async () => {
    const [row] = await db.select().from(timeEntries).where(eq(timeEntries.id, open[0].id));
    return row?.clockOutAt !== null;
  });
  const [closeAudit] = await db
    .select()
    .from(timeEntryAudit)
    .where(and(eq(timeEntryAudit.timeEntryId, open[0].id), eq(timeEntryAudit.action, "clock_out")));
  check("manager clock-out closes the punch with an audited reason", managerClosed && closeAudit?.reason === "Left without clocking out");

  await page.goto(`${BASE}/admin/settings`, { waitUntil: "networkidle" });
  await page.locator('select[name="timezone"]').selectOption(TZ);
  await page.fill('input[name="otWeeklyHours"]', "40");
  await page.fill('input[name="otDailyHours"]', "8");
  await page.fill('input[name="earlyClockInMinutes"]', "15");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.waitForURL(/saved=1/);
  const [rules] = await db.select().from(storeSettings).where(eq(storeSettings.id, 1));
  check(
    "staff settings save in minutes",
    rules?.timezone === TZ && rules.otWeeklyMinutes === 2400 && rules.otDailyMinutes === 480 && rules.dtDailyMinutes === null &&
      rules.earlyClockInMinutes === 15,
  );
  const laterStart = Math.min(nowMinutes + 120, 23 * 60);
  if (laterStart - nowMinutes >= 30) {
    const { startsAt, endsAt } = {
      startsAt: zonedInstant(today, hhmm(laterStart), TZ),
      endsAt: zonedInstant(today, hhmm(Math.min(laterStart + 50, 23 * 60 + 59)), TZ),
    };
    await db.delete(shifts).where(eq(shifts.employeeId, dana.id));
    await db.insert(shifts).values({ employeeId: dana.id, role: "pizza_maker", startsAt, endsAt, publishedAt: new Date() });
    await kiosk.goto(`${BASE}/timeclock`, { waitUntil: "networkidle" });
    await typePin(PIN);
    await kiosk.getByTestId("tc-clock-in").click();
    const refusal = await kiosk.getByTestId("tc-error").innerText();
    check("early clock-in is refused with the opening time", /^Your shift starts at .+\. You can clock in from .+\.$/.test(refusal), refusal);
    check(
      "a refused clock-in opens no punch",
      (await db.select().from(timeEntries).where(and(eq(timeEntries.employeeId, dana.id), isNull(timeEntries.clockOutAt)))).length === 0,
    );
    await kiosk.getByTestId("tc-done").click();
  } else {
    console.log("SKIP  early clock-in refusal (too close to midnight to schedule a later shift today)");
  }
  await db.update(storeSettings).set({ otDailyMinutes: null, earlyClockInMinutes: null }).where(eq(storeSettings.id, 1));

  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, storageState: await context.storageState() });
  const phonePage = await phone.newPage();
  await phonePage.goto(`${BASE}/admin/staff/schedule`, { waitUntil: "networkidle" });
  const pageWidth = await phonePage.evaluate(() => document.documentElement.scrollWidth);
  check("schedule fits a 375px phone (grid scrolls inside its card)", pageWidth <= 375, `scrollWidth ${pageWidth}`);
  await shot(phonePage, "schedule-375");
  await phonePage.goto(`${BASE}/timeclock`, { waitUntil: "networkidle" });
  for (const d of PIN) await phonePage.getByTestId(`tc-key-${d}`).click();
  await phonePage.getByTestId("tc-enter").click();
  await phonePage.getByTestId("tc-employee").waitFor();
  const kioskWidth = await phonePage.evaluate(() => document.documentElement.scrollWidth);
  check("kiosk employee view fits a 375px phone", kioskWidth <= 375, `scrollWidth ${kioskWidth}`);
  await shot(phonePage, "kiosk-375");
  await phone.close();

  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
