/**
 * Pure staff-domain checks: store-timezone calendar math, overtime-correct
 * payroll, the clock state machine, schedule conflicts and timesheet flags.
 *
 * Run: npx tsx scripts/test-timeclock.ts
 */
import assert from "node:assert/strict";
import {
  addDays,
  dayOfWeek,
  formatClock,
  formatDay,
  localDateOf,
  localDateSchema,
  minutesOfDay,
  shiftInstants,
  weekDates,
  weekStartOf,
  zonedInstant,
} from "../src/lib/zoned";
import {
  computeWeek,
  earlyClockInBlock,
  entryFlags,
  matchShift,
  planClock,
  punchProblem,
  remainingShiftMinutes,
  shiftConflicts,
  shiftCostCents,
  shiftPaidMinutes,
  type ClockAction,
  type ClockState,
  type PayEntry,
  type ShiftTimes,
} from "../src/lib/timeclock";

const NY = "America/New_York";
let passed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}`);
    throw e;
  }
}

const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();


test("localDateOf uses the store zone, not UTC", () => {
  assert.equal(localDateOf(at("2026-10-06T03:30:00Z"), NY), "2026-10-05");
  assert.equal(localDateOf(at("2026-10-06T04:30:00Z"), NY), "2026-10-06");
});

test("zonedInstant across the spring-forward day (2026-03-08)", () => {
  assert.equal(iso(zonedInstant("2026-03-08", "01:30", NY)), "2026-03-08T06:30:00.000Z");
  assert.equal(iso(zonedInstant("2026-03-08", "03:30", NY)), "2026-03-08T07:30:00.000Z");
  assert.equal(iso(zonedInstant("2026-03-07", "12:00", NY)), "2026-03-07T17:00:00.000Z");
  assert.equal(iso(zonedInstant("2026-03-09", "12:00", NY)), "2026-03-09T16:00:00.000Z");
});

test("zonedInstant across the fall-back day (2026-11-01)", () => {
  assert.equal(iso(zonedInstant("2026-11-01", "12:00", NY)), "2026-11-01T17:00:00.000Z");
  assert.equal(iso(zonedInstant("2026-10-31", "12:00", NY)), "2026-10-31T16:00:00.000Z");
});

test("overnight shift ends the next day, and loses an hour over spring-forward", () => {
  const close = shiftInstants("2026-10-09", "17:00", "02:00", NY);
  assert.equal(iso(close.startsAt), "2026-10-09T21:00:00.000Z");
  assert.equal(iso(close.endsAt), "2026-10-10T06:00:00.000Z");
  const dst = shiftInstants("2026-03-07", "20:00", "04:00", NY);
  assert.equal(iso(dst.startsAt), "2026-03-08T01:00:00.000Z");
  assert.equal(iso(dst.endsAt), "2026-03-08T08:00:00.000Z");
  assert.equal(shiftPaidMinutes({ ...dst, unpaidBreakMinutes: 0 }), 420);
});

test("calendar helpers", () => {
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(dayOfWeek("2026-10-05"), 1);
  assert.equal(weekStartOf("2026-10-03", 1), "2026-09-28");
  assert.equal(weekStartOf("2026-10-03", 0), "2026-09-27");
  assert.equal(weekStartOf("2026-09-28", 1), "2026-09-28");
  assert.deepEqual(weekDates("2026-09-28"), [
    "2026-09-28",
    "2026-09-29",
    "2026-09-30",
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
    "2026-10-04",
  ]);
  assert.equal(minutesOfDay(at("2026-10-05T20:05:00Z"), NY), 965);
  assert.equal(formatClock(at("2026-10-05T20:05:00Z"), NY), "4:05 PM");
  assert.equal(formatDay("2026-10-05"), "Mon, Oct 5");
  assert.equal(localDateSchema.safeParse("2026-02-30").success, false);
  assert.equal(localDateSchema.safeParse("2026-02-28").success, true);
});


const FEDERAL = { otWeeklyMinutes: 2400, otDailyMinutes: null, dtDailyMinutes: null };
const CALIFORNIA = { otWeeklyMinutes: 2400, otDailyMinutes: 480, dtDailyMinutes: 720 };

let nextId = 1;
function punch(
  date: string,
  from: string,
  to: string,
  rateCents: number,
  extra: Partial<PayEntry> = {},
): PayEntry {
  return {
    id: nextId++,
    role: "cook",
    rateCents,
    clockInAt: at(`${date}T${from}Z`),
    clockOutAt: at(`${date}T${to}Z`),
    breaks: [],
    declaredTipsCents: 0,
    ...extra,
  };
}
const NOW = at("2026-10-20T00:00:00Z");

test("45 h at $15 → 5 h overtime, $712.50 gross", () => {
  const week = computeWeek(
    ["05", "06", "07", "08", "09"].map((d) => punch(`2026-10-${d}`, "09:00:00", "18:00:00", 1500)),
    FEDERAL,
    "UTC",
    NOW,
  );
  assert.deepEqual(week.totals, { paidMinutes: 2700, regularMinutes: 2400, otMinutes: 300, dtMinutes: 0, breakMinutes: 0 });
  assert.deepEqual(week.days[4], { date: "2026-10-09", paidMinutes: 540, regularMinutes: 240, otMinutes: 300, dtMinutes: 0, breakMinutes: 0 });
  assert.equal(week.straightCents, 67500);
  assert.equal(week.premiumCents, 3750);
  assert.equal(week.grossCents, 71250);
});

test("two roles at different rates → weighted-average overtime premium", () => {
  const entries = [
    punch("2026-10-05", "08:00:00", "18:00:00", 1500),
    punch("2026-10-06", "08:00:00", "18:00:00", 1500),
    punch("2026-10-07", "08:00:00", "18:00:00", 1500),
    punch("2026-10-08", "10:00:00", "17:30:00", 2000, { role: "driver" }),
    punch("2026-10-09", "10:00:00", "17:30:00", 2000, { role: "driver", declaredTipsCents: 4200 }),
  ];
  const week = computeWeek(entries, FEDERAL, "UTC", NOW);
  assert.equal(week.totals.otMinutes, 300);
  // $750 straight; regular rate $16.667/h; 5 h × $8.333 = $41.67.
  assert.equal(week.straightCents, 75000);
  assert.equal(week.premiumCents, 4167);
  assert.equal(week.grossCents, 79167);
  assert.equal(week.tipsCents, 4200);
});

test("California daily 8/12 plus weekly 40 without double counting", () => {
  const entries = [
    punch("2026-10-05", "08:00:00", "21:00:00", 2000),
    ...["06", "07", "08", "09"].map((d) => punch(`2026-10-${d}`, "09:00:00", "17:00:00", 2000)),
    punch("2026-10-10", "10:00:00", "14:00:00", 2000),
  ];
  const week = computeWeek(entries, CALIFORNIA, "UTC", NOW);
  assert.deepEqual(week.days[0], { date: "2026-10-05", paidMinutes: 780, regularMinutes: 480, otMinutes: 240, dtMinutes: 60, breakMinutes: 0 });
  assert.deepEqual(week.days[5], { date: "2026-10-10", paidMinutes: 240, regularMinutes: 0, otMinutes: 240, dtMinutes: 0, breakMinutes: 0 });
  assert.deepEqual(week.totals, { paidMinutes: 2940, regularMinutes: 2400, otMinutes: 480, dtMinutes: 60, breakMinutes: 0 });
  assert.equal(week.straightCents, 98000);
  assert.equal(week.grossCents, 108000);
});

test("unpaid breaks are deducted, paid breaks are not, seconds are floored", () => {
  const entry = punch("2026-10-05", "09:00:00", "17:30:59", 1200, {
    breaks: [
      { startedAt: at("2026-10-05T12:00:00Z"), endedAt: at("2026-10-05T12:30:00Z"), paid: false },
      { startedAt: at("2026-10-05T15:00:00Z"), endedAt: at("2026-10-05T15:10:00Z"), paid: true },
    ],
  });
  const week = computeWeek([entry], FEDERAL, "UTC", NOW);
  assert.deepEqual(week.days[0], { date: "2026-10-05", paidMinutes: 480, regularMinutes: 480, otMinutes: 0, dtMinutes: 0, breakMinutes: 30 });
  assert.equal(week.grossCents, 9600);
});

test("an open punch counts up to now and stops while on an unpaid break", () => {
  const entry = punch("2026-10-05", "09:00:00", "09:00:00", 1200, {
    clockOutAt: null,
    breaks: [{ startedAt: at("2026-10-05T10:30:00Z"), endedAt: null, paid: false }],
  });
  const week = computeWeek([entry], FEDERAL, "UTC", at("2026-10-05T11:00:30Z"));
  assert.deepEqual(week.entries, [{ id: entry.id, date: "2026-10-05", paidMinutes: 90, breakMinutes: 30, open: true }]);
});

test("a punch belongs to the store-local day it started on", () => {
  // 9 PM–1 AM in New York is 01:00–05:00 UTC the next day.
  const entry = punch("2026-10-06", "01:00:00", "05:00:00", 1500);
  assert.equal(computeWeek([entry], FEDERAL, NY, NOW).days[0].date, "2026-10-05");
});

test("punchProblem rejects impossible hand-entered punches", () => {
  const d = (hhmm: string) => at(`2026-10-05T${hhmm}:00Z`);
  const brk = (from: string, to: string | null, paid = false) => ({ startedAt: d(from), endedAt: to ? d(to) : null, paid });
  assert.equal(punchProblem(d("09:00"), d("17:00"), [brk("12:00", "12:30")], NOW), null);
  assert.equal(punchProblem(d("09:00"), d("09:00"), [], NOW), "Clock-out must be after clock-in.");
  assert.equal(punchProblem(d("09:00"), null, [], d("08:00")), "Clock-in can't be in the future.");
  assert.equal(punchProblem(d("09:00"), d("17:00"), [brk("08:30", "09:30")], NOW), "Breaks must fall inside the punch.");
  assert.equal(punchProblem(d("09:00"), d("17:00"), [brk("12:00", "12:30"), brk("12:15", "12:45")], NOW), "Breaks overlap.");
  assert.equal(punchProblem(d("09:00"), d("17:00"), [brk("12:00", null)], NOW), "End every break before the clock-out.");
  assert.equal(punchProblem(d("09:00"), null, [brk("12:00", null)], d("12:10")), null);
});


test("clock transitions: apply, replay or refuse for every state × action", () => {
  const states: ClockState[] = [
    { kind: "off" },
    { kind: "working", entryId: 1, role: "cook", since: "2026-10-05T16:00:00Z" },
    { kind: "on_break", entryId: 1, breakId: 2, paid: false, since: "2026-10-05T18:00:00Z", shiftSince: "2026-10-05T16:00:00Z" },
  ];
  const actions: ClockAction[] = [
    { type: "clock_in", role: "cook" },
    { type: "start_break", paid: false },
    { type: "end_break" },
    { type: "clock_out", declaredTipsCents: 0 },
  ];
  const matrix = states.map((s) => actions.map((a) => planClock(s, a).kind));
  assert.deepEqual(matrix, [
    ["apply", "refuse", "refuse", "replay"],
    ["replay", "apply", "replay", "apply"],
    ["replay", "replay", "apply", "refuse"],
  ]);
  assert.deepEqual(planClock(states[2], actions[3]), { kind: "refuse", message: "End your break before clocking out." });
  assert.deepEqual(planClock(states[1], actions[0]), { kind: "replay", message: "You're already clocked in." });
});


const RULES = { otWeeklyMinutes: 2400, weekStartsOn: 1 };
function shiftOn(date: string, from: string, to: string, id: number | null = null, unpaidBreakMinutes = 0): ShiftTimes {
  return { id, ...shiftInstants(date, from, to, NY), unpaidBreakMinutes };
}
const TUESDAY = shiftOn("2026-10-06", "16:00", "22:00", 100);

test("shift conflicts: none for a clean shift", () => {
  assert.deepEqual(shiftConflicts(TUESDAY, [TUESDAY], [], null, RULES, NY), []);
});

test("shift conflicts: overlap", () => {
  assert.deepEqual(shiftConflicts(TUESDAY, [shiftOn("2026-10-06", "21:00", "23:00", 101)], [], null, RULES, NY), ["overlap"]);
  assert.deepEqual(shiftConflicts(TUESDAY, [shiftOn("2026-10-06", "22:00", "23:00", 101)], [], null, RULES, NY), []);
});

test("shift conflicts: approved and pending time off; denied is ignored", () => {
  const off = (status: "approved" | "pending" | "denied") => [{ startDate: "2026-10-05", endDate: "2026-10-06", status }];
  assert.deepEqual(shiftConflicts(TUESDAY, [], off("approved"), null, RULES, NY), ["time_off"]);
  assert.deepEqual(shiftConflicts(TUESDAY, [], off("pending"), null, RULES, NY), ["time_off_pending"]);
  assert.deepEqual(shiftConflicts(TUESDAY, [], off("denied"), null, RULES, NY), []);
  // An overnight close reaches into the next day's time off.
  const close = shiftOn("2026-10-06", "18:00", "01:00", 102);
  assert.deepEqual(
    shiftConflicts(close, [], [{ startDate: "2026-10-07", endDate: "2026-10-07", status: "approved" }], null, RULES, NY),
    ["time_off"],
  );
});

test("shift conflicts: outside weekly availability", () => {
  const window = (from: string, to: string) => [{ day: 2 as const, kind: "window" as const, from, to }];
  assert.deepEqual(shiftConflicts(TUESDAY, [], [], window("10:00", "18:00"), RULES, NY), ["unavailable"]);
  assert.deepEqual(shiftConflicts(TUESDAY, [], [], window("15:00", "23:00"), RULES, NY), []);
  assert.deepEqual(shiftConflicts(TUESDAY, [], [], [{ day: 2, kind: "none" }], RULES, NY), ["unavailable"]);
  assert.deepEqual(shiftConflicts(TUESDAY, [], [], [{ day: 3, kind: "none" }], RULES, NY), []);
  const close = shiftOn("2026-10-06", "17:00", "01:00", 103);
  assert.deepEqual(shiftConflicts(close, [], [], window("16:00", "02:00"), RULES, NY), []);
});

test("shift conflicts: overtime counts only the shift's payroll week", () => {
  const sameWeek = ["05", "07", "08", "09"].map((d, i) => shiftOn(`2026-10-${d}`, "09:00", "18:00", 200 + i));
  assert.deepEqual(shiftConflicts(TUESDAY, sameWeek, [], null, RULES, NY), ["overtime"]);
  const lastWeek = ["28", "29", "30"].map((d, i) => shiftOn(`2026-09-${d}`, "09:00", "18:00", 300 + i));
  assert.deepEqual(shiftConflicts(TUESDAY, [...lastWeek, sameWeek[0]], [], null, RULES, NY), []);
});

test("shift paid minutes and labor cost", () => {
  const s = shiftOn("2026-10-06", "16:00", "22:00", 1, 30);
  assert.equal(shiftPaidMinutes(s), 330);
  assert.equal(shiftCostCents(s, 1500), 8250);
});

test("remaining scheduled minutes count the rest of a shift under way", () => {
  const lunch = shiftOn("2026-10-06", "10:00", "14:00", 1, 30);
  const dinner = shiftOn("2026-10-06", "16:00", "22:00", 2, 30);
  const at1230 = zonedInstant("2026-10-06", "12:30", NY);
  assert.equal(remainingShiftMinutes([lunch, dinner], at1230), 90 + 330);
  assert.equal(remainingShiftMinutes([lunch, dinner], zonedInstant("2026-10-06", "09:00", NY)), 210 + 330);
  assert.equal(remainingShiftMinutes([lunch, dinner], zonedInstant("2026-10-06", "23:00", NY)), 0);
});


test("matchShift: [start − 2 h, end], nearest start first", () => {
  const lunch = shiftOn("2026-10-06", "10:00", "14:00", 1);
  const dinner = shiftOn("2026-10-06", "16:00", "22:00", 2);
  const ny = (hhmm: string) => zonedInstant("2026-10-06", hhmm, NY);
  assert.equal(matchShift(ny("15:00"), [lunch, dinner])?.id, 2);
  assert.equal(matchShift(ny("13:30"), [lunch, dinner])?.id, 1);
  assert.equal(matchShift(ny("07:00"), [lunch, dinner]), null);
  assert.equal(matchShift(ny("23:00"), [lunch, dinner]), null);
  const late = shiftOn("2026-10-06", "14:30", "20:00", 3);
  assert.equal(matchShift(ny("13:50"), [lunch, late])?.id, 3);
});

test("early clock-in refusal", () => {
  const dinner = shiftOn("2026-10-06", "16:00", "22:00", 2);
  const ny = (hhmm: string) => zonedInstant("2026-10-06", hhmm, NY);
  assert.equal(iso(earlyClockInBlock(ny("15:30"), [dinner], { earlyClockInMinutes: 10 }, NY)!.opensAt), iso(ny("15:50")));
  assert.equal(earlyClockInBlock(ny("15:52"), [dinner], { earlyClockInMinutes: 10 }, NY), null);
  assert.equal(earlyClockInBlock(ny("15:30"), [dinner], { earlyClockInMinutes: null }, NY), null);
  const tomorrow = shiftOn("2026-10-07", "16:00", "22:00", 3);
  assert.equal(earlyClockInBlock(ny("15:30"), [tomorrow], { earlyClockInMinutes: 10 }, NY), null);
});


const FLAG_RULES = { breakRequiredAfterMinutes: 360, clockGraceMinutes: 7 };
const SHIFT = { startsAt: at("2026-10-05T16:00:00Z"), endsAt: at("2026-10-05T22:00:00Z") };
const lunch = { startedAt: at("2026-10-05T19:00:00Z"), endedAt: at("2026-10-05T19:30:00Z"), paid: false };
function flagged(from: string, to: string | null, extra: Partial<PayEntry> = {}, edited = false) {
  return {
    ...punch("2026-10-05", from, to ?? from, 1500, extra),
    ...(to === null ? { clockOutAt: null } : {}),
    edited,
  };
}

test("entry flags: none for an on-time punch with a meal break", () => {
  assert.deepEqual(entryFlags(flagged("15:58:00", "22:00:00", { breaks: [lunch] }), SHIFT, FLAG_RULES, NOW), []);
});

test("entry flags: late beyond the grace period only", () => {
  assert.deepEqual(entryFlags(flagged("16:08:00", "22:00:00", { breaks: [lunch] }), SHIFT, FLAG_RULES, NOW), ["late"]);
  assert.deepEqual(entryFlags(flagged("16:07:00", "22:00:00", { breaks: [lunch] }), SHIFT, FLAG_RULES, NOW), []);
});

test("entry flags: early out", () => {
  assert.deepEqual(entryFlags(flagged("15:58:00", "21:50:00", { breaks: [lunch] }), SHIFT, FLAG_RULES, NOW), ["early_out"]);
});

test("entry flags: no unpaid break past the threshold", () => {
  assert.deepEqual(entryFlags(flagged("15:58:00", "22:00:00"), SHIFT, FLAG_RULES, NOW), ["no_break"]);
  const paidOnly = { ...lunch, paid: true };
  assert.deepEqual(entryFlags(flagged("15:58:00", "22:00:00", { breaks: [paidOnly] }), SHIFT, FLAG_RULES, NOW), ["no_break"]);
  assert.deepEqual(
    entryFlags(flagged("15:58:00", "22:00:00"), SHIFT, { ...FLAG_RULES, breakRequiredAfterMinutes: null }, NOW),
    [],
  );
});

test("entry flags: unscheduled and edited", () => {
  assert.deepEqual(entryFlags(flagged("16:00:00", "20:00:00"), null, FLAG_RULES, NOW), ["unscheduled"]);
  assert.deepEqual(entryFlags(flagged("16:00:00", "20:00:00", {}, true), SHIFT, FLAG_RULES, NOW), ["early_out", "edited"]);
});

test("entry flags: missed clock-out after 14 h open", () => {
  const open = flagged("16:00:00", null);
  assert.deepEqual(entryFlags(open, SHIFT, FLAG_RULES, at("2026-10-06T05:00:00Z")), ["no_break"]);
  assert.deepEqual(entryFlags(open, SHIFT, FLAG_RULES, at("2026-10-06T06:30:00Z")), ["missed_clock_out", "no_break"]);
});

test("entry flags: break open over an hour", () => {
  const onBreak = flagged("16:00:00", null, {
    breaks: [{ startedAt: at("2026-10-05T17:00:00Z"), endedAt: null, paid: false }],
  });
  assert.deepEqual(entryFlags(onBreak, SHIFT, FLAG_RULES, at("2026-10-05T17:59:00Z")), []);
  assert.deepEqual(entryFlags(onBreak, SHIFT, FLAG_RULES, at("2026-10-05T18:05:00Z")), ["on_break_long"]);
});

console.log(`\n${passed} passed`);
