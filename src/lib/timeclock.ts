/**
 * Staff time clock and scheduling domain: job roles, the clock state machine,
 * overtime-correct payroll math, timesheet exceptions and schedule conflicts.
 * Shared by server and client — no I/O. Calendar math is in `zoned.ts`.
 */
import {
  dayOfWeek,
  localDateOf,
  minutesOfDay,
  weekStartOf,
  type LocalDate,
} from "@/lib/zoned";

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const JOB_ROLES = [
  "manager",
  "shift_lead",
  "pizza_maker",
  "cook",
  "cashier",
  "driver",
  "dishwasher",
] as const;
export type JobRole = (typeof JOB_ROLES)[number];

export const ROLE_LABEL: Record<JobRole, string> = {
  manager: "Manager",
  shift_lead: "Shift lead",
  pizza_maker: "Pizza maker",
  cook: "Cook",
  cashier: "Cashier",
  driver: "Driver",
  dishwasher: "Dishwasher",
};

export const ROLE_TONE: Record<JobRole, string> = {
  manager: "bg-violet-100 text-violet-900 border-violet-300 dark:bg-violet-950 dark:text-violet-100 dark:border-violet-800",
  shift_lead: "bg-indigo-100 text-indigo-900 border-indigo-300 dark:bg-indigo-950 dark:text-indigo-100 dark:border-indigo-800",
  pizza_maker: "bg-red-100 text-red-900 border-red-300 dark:bg-red-950 dark:text-red-100 dark:border-red-800",
  cook: "bg-orange-100 text-orange-900 border-orange-300 dark:bg-orange-950 dark:text-orange-100 dark:border-orange-800",
  cashier: "bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-800",
  driver: "bg-sky-100 text-sky-900 border-sky-300 dark:bg-sky-950 dark:text-sky-100 dark:border-sky-800",
  dishwasher: "bg-zinc-100 text-zinc-900 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-100 dark:border-zinc-600",
};

// ---------------------------------------------------------------------------
// Store rules
// ---------------------------------------------------------------------------

export type StaffRules = {
  weekStartsOn: number;
  otWeeklyMinutes: number;
  otDailyMinutes: number | null;
  dtDailyMinutes: number | null;
  breakRequiredAfterMinutes: number | null;
  clockGraceMinutes: number;
  earlyClockInMinutes: number | null;
};

export const DEFAULT_STAFF_RULES: StaffRules = {
  weekStartsOn: 1,
  otWeeklyMinutes: 2400,
  otDailyMinutes: null,
  dtDailyMinutes: null,
  breakRequiredAfterMinutes: 360,
  clockGraceMinutes: 7,
  earlyClockInMinutes: null,
};

// ---------------------------------------------------------------------------
// Clock state machine
// ---------------------------------------------------------------------------

export type ClockState =
  | { kind: "off" }
  | { kind: "working"; entryId: number; role: JobRole; since: string }
  | { kind: "on_break"; entryId: number; breakId: number; paid: boolean; since: string; shiftSince: string };

export type ClockAction =
  | { type: "clock_in"; role: JobRole }
  | { type: "start_break"; paid: boolean }
  | { type: "end_break" }
  | { type: "clock_out"; declaredTipsCents: number };

// Clock-out from a break is not offered: ending the break first keeps every
// break record closed.
export const ALLOWED: Record<ClockState["kind"], ClockAction["type"][]> = {
  off: ["clock_in"],
  working: ["start_break", "clock_out"],
  on_break: ["end_break"],
};

/** The state each action leads to: finding the clock already there means a retry. */
const LEADS_TO: Record<ClockAction["type"], ClockState["kind"][]> = {
  clock_in: ["working", "on_break"],
  start_break: ["on_break"],
  end_break: ["working"],
  clock_out: ["off"],
};

const ALREADY: Record<ClockAction["type"], string> = {
  clock_in: "You're already clocked in.",
  start_break: "You're already on a break.",
  end_break: "Your break already ended.",
  clock_out: "You're already clocked out.",
};

const REFUSED: Record<ClockAction["type"], string> = {
  clock_in: "You're already clocked in.",
  start_break: "Clock in before starting a break.",
  end_break: "You're not on a break.",
  clock_out: "End your break before clocking out.",
};

export type ClockPlan =
  | { kind: "apply" }
  | { kind: "replay"; message: string }
  | { kind: "refuse"; message: string };

/**
 * Whether an action applies to the current state. A double tap or a retried
 * request finds the clock already where the action leads; that is a replay,
 * answered with the current view rather than an error or a second row.
 */
export function planClock(state: ClockState, action: ClockAction): ClockPlan {
  if (ALLOWED[state.kind].includes(action.type)) return { kind: "apply" };
  if (LEADS_TO[action.type].includes(state.kind)) return { kind: "replay", message: ALREADY[action.type] };
  return { kind: "refuse", message: REFUSED[action.type] };
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

export type PayBreak = { startedAt: Date; endedAt: Date | null; paid: boolean };

export type PayEntry = {
  id: number;
  role: JobRole;
  rateCents: number;
  clockInAt: Date;
  /** Null while on the clock; live views count it up to `now`. */
  clockOutAt: Date | null;
  breaks: PayBreak[];
  declaredTipsCents: number;
};

const MINUTE = 60_000;

/** Paid and unpaid-break minutes for one punch, whole minutes (seconds floored). */
export function entryMinutes(
  entry: Pick<PayEntry, "clockInAt" | "clockOutAt" | "breaks">,
  now: Date,
): { paidMinutes: number; breakMinutes: number } {
  const start = entry.clockInAt.getTime();
  const end = (entry.clockOutAt ?? now).getTime();
  let unpaidMs = 0;
  for (const b of entry.breaks) {
    if (b.paid) continue;
    const from = Math.max(b.startedAt.getTime(), start);
    const to = Math.min((b.endedAt ?? now).getTime(), end);
    unpaidMs += Math.max(0, to - from);
  }
  return {
    paidMinutes: Math.max(0, Math.floor((end - start - unpaidMs) / MINUTE)),
    breakMinutes: Math.floor(unpaidMs / MINUTE),
  };
}

export type DayPay = {
  date: LocalDate;
  paidMinutes: number;
  regularMinutes: number;
  otMinutes: number;
  dtMinutes: number;
  /** Unpaid break minutes (deducted). */
  breakMinutes: number;
};

export type WeekPay = {
  days: DayPay[];
  totals: Omit<DayPay, "date">;
  entries: { id: number; date: LocalDate; paidMinutes: number; breakMinutes: number; open: boolean }[];
  straightCents: number;
  premiumCents: number;
  grossCents: number;
  tipsCents: number;
};

/** a / b rounded half up, for non-negative integers. */
function roundDiv(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b));
}

/**
 * One employee's payroll week. Each punch belongs to the store-local date it
 * started on, so an overnight close counts toward the day the shift began.
 * Daily overtime (and double time) is taken first; weekly overtime then
 * converts only the regular minutes past the weekly threshold, walking the
 * days in order, so no minute is counted twice.
 *
 * Pay follows the FLSA weighted-average method: every paid minute earns its
 * own rate at straight time; the regular rate is straight pay over total
 * minutes; overtime minutes add half the regular rate and double-time
 * minutes a full regular rate. Cents are rounded once, at the end.
 */
export function computeWeek(
  entries: PayEntry[],
  rules: Pick<StaffRules, "otWeeklyMinutes" | "otDailyMinutes" | "dtDailyMinutes">,
  tz: string,
  now: Date,
): WeekPay {
  const sorted = entries.toSorted((a, b) => a.clockInAt.getTime() - b.clockInAt.getTime());
  const perEntry = sorted.map((e) => ({
    id: e.id,
    date: localDateOf(e.clockInAt, tz),
    open: e.clockOutAt === null,
    ...entryMinutes(e, now),
  }));

  const byDate = new Map<LocalDate, { paid: number; breaks: number }>();
  for (const e of perEntry) {
    const d = byDate.get(e.date) ?? { paid: 0, breaks: 0 };
    d.paid += e.paidMinutes;
    d.breaks += e.breakMinutes;
    byDate.set(e.date, d);
  }

  let weekRegular = 0;
  const days: DayPay[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { paid, breaks }]) => {
      const dt = rules.dtDailyMinutes === null ? 0 : Math.max(0, paid - rules.dtDailyMinutes);
      const ot =
        rules.otDailyMinutes === null
          ? 0
          : Math.max(0, Math.min(paid, rules.dtDailyMinutes ?? Infinity) - rules.otDailyMinutes);
      let regular = paid - ot - dt;
      const overWeekly = Math.max(0, regular - Math.max(0, rules.otWeeklyMinutes - weekRegular));
      regular -= overWeekly;
      weekRegular += regular;
      return { date, paidMinutes: paid, regularMinutes: regular, otMinutes: ot + overWeekly, dtMinutes: dt, breakMinutes: breaks };
    });

  const totals = days.reduce(
    (t, d) => ({
      paidMinutes: t.paidMinutes + d.paidMinutes,
      regularMinutes: t.regularMinutes + d.regularMinutes,
      otMinutes: t.otMinutes + d.otMinutes,
      dtMinutes: t.dtMinutes + d.dtMinutes,
      breakMinutes: t.breakMinutes + d.breakMinutes,
    }),
    { paidMinutes: 0, regularMinutes: 0, otMinutes: 0, dtMinutes: 0, breakMinutes: 0 },
  );

  // Straight pay in cent-minutes per hour: Σ minutes × hourly cents.
  const straight = sorted.reduce((s, e, i) => s + perEntry[i].paidMinutes * e.rateCents, 0);
  const total = totals.paidMinutes;
  const straightCents = roundDiv(straight, 60);
  // straight/60 + (OT × ½ + DT × 1) × straight / (60 × total), over one denominator.
  const grossCents =
    total === 0
      ? 0
      : roundDiv(straight * (2 * total + totals.otMinutes + 2 * totals.dtMinutes), 120 * total);

  return {
    days,
    totals,
    entries: perEntry.map(({ id, date, paidMinutes, breakMinutes, open }) => ({
      id,
      date,
      paidMinutes,
      breakMinutes,
      open,
    })),
    straightCents,
    premiumCents: grossCents - straightCents,
    grossCents,
    tipsCents: sorted.reduce((s, e) => s + e.declaredTipsCents, 0),
  };
}

/** Why a hand-entered punch can't be saved, or null when it can. */
export function punchProblem(
  clockInAt: Date,
  clockOutAt: Date | null,
  breaks: PayBreak[],
  now: Date,
): string | null {
  if (clockInAt > now) return "Clock-in can't be in the future.";
  if (clockOutAt !== null && clockOutAt <= clockInAt) return "Clock-out must be after clock-in.";
  if (clockOutAt !== null && clockOutAt > now) return "Clock-out can't be in the future.";
  const end = clockOutAt ?? now;
  const sorted = breaks.toSorted((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  for (const [i, b] of sorted.entries()) {
    if (b.endedAt === null && clockOutAt !== null) return "End every break before the clock-out.";
    if (b.endedAt !== null && b.endedAt < b.startedAt) return "A break ends before it starts.";
    if (b.startedAt < clockInAt || (b.endedAt ?? end) > end) return "Breaks must fall inside the punch.";
    const next = sorted[i + 1];
    if (next && next.startedAt < (b.endedAt ?? end)) return "Breaks overlap.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Timesheet exceptions
// ---------------------------------------------------------------------------

export const ENTRY_FLAGS = [
  "missed_clock_out",
  "on_break_long",
  "no_break",
  "late",
  "early_out",
  "unscheduled",
  "edited",
] as const;
export type EntryFlag = (typeof ENTRY_FLAGS)[number];

export type Severity = "critical" | "warning" | "info";

export const FLAG_LABEL: Record<EntryFlag, { label: string; severity: Severity }> = {
  missed_clock_out: { label: "Missed clock-out", severity: "critical" },
  on_break_long: { label: "Break over an hour", severity: "warning" },
  no_break: { label: "No meal break", severity: "warning" },
  late: { label: "Late", severity: "warning" },
  early_out: { label: "Left early", severity: "info" },
  unscheduled: { label: "Unscheduled", severity: "info" },
  edited: { label: "Edited", severity: "info" },
};

const MISSED_CLOCK_OUT_MS = 14 * 60 * MINUTE;
const LONG_BREAK_MS = 60 * MINUTE;

export function entryFlags(
  entry: PayEntry & { edited: boolean },
  shift: { startsAt: Date; endsAt: Date } | null,
  rules: Pick<StaffRules, "breakRequiredAfterMinutes" | "clockGraceMinutes">,
  now: Date,
): EntryFlag[] {
  const flags: EntryFlag[] = [];
  const grace = rules.clockGraceMinutes * MINUTE;
  if (entry.clockOutAt === null && now.getTime() - entry.clockInAt.getTime() > MISSED_CLOCK_OUT_MS) {
    flags.push("missed_clock_out");
  }
  if (
    entry.clockOutAt === null &&
    entry.breaks.some((b) => b.endedAt === null && now.getTime() - b.startedAt.getTime() > LONG_BREAK_MS)
  ) {
    flags.push("on_break_long");
  }
  if (
    rules.breakRequiredAfterMinutes !== null &&
    entryMinutes(entry, now).paidMinutes > rules.breakRequiredAfterMinutes &&
    !entry.breaks.some((b) => !b.paid)
  ) {
    flags.push("no_break");
  }
  if (shift === null) {
    flags.push("unscheduled");
  } else {
    if (entry.clockInAt.getTime() > shift.startsAt.getTime() + grace) flags.push("late");
    if (entry.clockOutAt !== null && entry.clockOutAt.getTime() < shift.endsAt.getTime() - grace) {
      flags.push("early_out");
    }
  }
  if (entry.edited) flags.push("edited");
  return flags;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type DayAvailability =
  | { day: Weekday; kind: "any" }
  | { day: Weekday; kind: "none" }
  | { day: Weekday; kind: "window"; from: string; to: string };

/** One entry per weekday; a missing day or a null availability means any time. */
export type WeeklyAvailability = DayAvailability[];

export type ShiftTimes = {
  id: number | null;
  startsAt: Date;
  endsAt: Date;
  unpaidBreakMinutes: number;
};

export type TimeOffLike = {
  startDate: LocalDate;
  endDate: LocalDate;
  status: "pending" | "approved" | "denied";
};

export function shiftPaidMinutes(shift: Omit<ShiftTimes, "id">): number {
  const minutes = Math.round((shift.endsAt.getTime() - shift.startsAt.getTime()) / MINUTE);
  return Math.max(0, minutes - shift.unpaidBreakMinutes);
}

export function shiftCostCents(shift: Omit<ShiftTimes, "id">, rateCents: number): number {
  return Math.round((shiftPaidMinutes(shift) * rateCents) / 60);
}

export const SHIFT_CONFLICTS = ["overlap", "time_off", "time_off_pending", "unavailable", "overtime"] as const;
export type ShiftConflict = (typeof SHIFT_CONFLICTS)[number];

export const CONFLICT_LABEL: Record<ShiftConflict, string> = {
  overlap: "Overlaps another shift",
  time_off: "Approved time off",
  time_off_pending: "Time off requested",
  unavailable: "Outside availability",
  overtime: "Puts them into overtime",
};

/** The store-local dates a shift touches (an overnight close touches two). */
export function shiftDates(shift: Pick<ShiftTimes, "startsAt" | "endsAt">, tz: string): [LocalDate, LocalDate] {
  return [localDateOf(shift.startsAt, tz), localDateOf(new Date(shift.endsAt.getTime() - 1), tz)];
}

export function dayAvailability(availability: WeeklyAvailability | null, day: number): DayAvailability {
  return availability?.find((a) => a.day === day) ?? { day: day as Weekday, kind: "any" };
}

function hhmmMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function outsideAvailability(shift: ShiftTimes, availability: WeeklyAvailability | null, tz: string): boolean {
  const [date] = shiftDates(shift, tz);
  const a = dayAvailability(availability, dayOfWeek(date));
  if (a.kind === "any") return false;
  if (a.kind === "none") return true;
  const start = minutesOfDay(shift.startsAt, tz);
  const end = start + (shift.endsAt.getTime() - shift.startsAt.getTime()) / MINUTE;
  const from = hhmmMinutes(a.from);
  let to = hhmmMinutes(a.to);
  if (to <= from) to += 24 * 60;
  return start < from || end > to;
}

/**
 * What is wrong with scheduling this shift for its employee, given their other
 * shifts, time off and weekly availability. `overtime` counts the scheduled
 * minutes of the payroll week the shift starts in, this shift included.
 */
export function shiftConflicts(
  shift: ShiftTimes,
  sameEmployeeShifts: ShiftTimes[],
  timeOff: TimeOffLike[],
  availability: WeeklyAvailability | null,
  rules: Pick<StaffRules, "otWeeklyMinutes" | "weekStartsOn">,
  tz: string,
): ShiftConflict[] {
  const others = sameEmployeeShifts.filter((s) => s.id === null || s.id !== shift.id);
  const conflicts: ShiftConflict[] = [];
  if (others.some((s) => s.startsAt < shift.endsAt && s.endsAt > shift.startsAt)) conflicts.push("overlap");

  const [first, last] = shiftDates(shift, tz);
  const touching = timeOff.filter((t) => t.startDate <= last && t.endDate >= first);
  if (touching.some((t) => t.status === "approved")) conflicts.push("time_off");
  if (touching.some((t) => t.status === "pending")) conflicts.push("time_off_pending");

  if (outsideAvailability(shift, availability, tz)) conflicts.push("unavailable");

  const week = weekStartOf(first, rules.weekStartsOn);
  const weekMinutes = [shift, ...others]
    .filter((s) => weekStartOf(localDateOf(s.startsAt, tz), rules.weekStartsOn) === week)
    .reduce((sum, s) => sum + shiftPaidMinutes(s), 0);
  if (weekMinutes > rules.otWeeklyMinutes) conflicts.push("overtime");
  return conflicts;
}

const MATCH_EARLY_MS = 2 * 60 * MINUTE;

/** The published shift a punch belongs to: [start − 2 h, end] contains it, nearest start first. */
export function matchShift<S extends Pick<ShiftTimes, "startsAt" | "endsAt">>(
  clockIn: Date,
  shifts: S[],
): S | null {
  const t = clockIn.getTime();
  const candidates = shifts.filter(
    (s) => t >= s.startsAt.getTime() - MATCH_EARLY_MS && t <= s.endsAt.getTime(),
  );
  candidates.sort((a, b) => Math.abs(a.startsAt.getTime() - t) - Math.abs(b.startsAt.getTime() - t));
  return candidates[0] ?? null;
}

/**
 * With "prevent early clock-in" on, a punch more than N minutes before the
 * employee's next shift today is refused. Unscheduled days stay open, and a
 * manager can always add the time by hand.
 */
export function earlyClockInBlock<S extends Pick<ShiftTimes, "startsAt" | "endsAt">>(
  now: Date,
  shifts: S[],
  rules: Pick<StaffRules, "earlyClockInMinutes">,
  tz: string,
): { shift: S; opensAt: Date } | null {
  if (rules.earlyClockInMinutes === null) return null;
  const next = shifts
    .filter((s) => s.endsAt > now)
    .toSorted((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
  if (!next || localDateOf(next.startsAt, tz) !== localDateOf(now, tz)) return null;
  const opensAt = new Date(next.startsAt.getTime() - rules.earlyClockInMinutes * MINUTE);
  return now < opensAt ? { shift: next, opensAt } : null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** 450 → "7h 30m" */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** 450 → "7.50", the payroll convention. */
export function decimalHours(minutes: number): string {
  return (minutes / 60).toFixed(2);
}

// ---------------------------------------------------------------------------
// Audit and kiosk wire types
// ---------------------------------------------------------------------------

/** A time entry as recorded in the audit log, before and after a change. */
export type AuditSnapshot = {
  role: JobRole;
  rateCents: number;
  clockInAt: string;
  clockOutAt: string | null;
  declaredTipsCents: number;
  note: string | null;
  breaks: { startedAt: string; endedAt: string | null; paid: boolean }[];
};

export type KioskShift = {
  id: number;
  role: JobRole;
  startsAt: string;
  endsAt: string;
  unpaidBreakMinutes: number;
};

export type KioskView = {
  employee: { id: number; name: string; roles: JobRole[] };
  state: ClockState;
  defaultRole: JobRole;
  todayShifts: KioskShift[];
  /** Published shifts in the next 7 days, after today. */
  upcoming: KioskShift[];
  week: { paidMinutes: number; projectedMinutes: number };
  /** The punch in progress, counted up to now. */
  current: { paidMinutes: number; breakMinutes: number } | null;
  timeOff: { id: number; startDate: LocalDate; endDate: LocalDate; status: "pending" | "approved" }[];
};

export type KioskAction =
  | ClockAction
  | { type: "request_time_off"; startDate: LocalDate; endDate: LocalDate; reason: string };

export type KioskRequest = { pin: string; action?: KioskAction };

export type ShiftSummary = {
  clockInAt: string;
  clockOutAt: string;
  paidMinutes: number;
  breakMinutes: number;
  declaredTipsCents: number;
};

export type KioskResponse = {
  view: KioskView;
  /** Confirmation, replay or refusal text to show the employee. */
  message: string | null;
  tone: "success" | "info" | "error";
  summary: ShiftSummary | null;
};

export type KioskBoard = { serverNow: string; timezone: string; onClock: number };
