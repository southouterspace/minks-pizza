/**
 * Staff time clock and scheduling domain: job roles, the clock state machine,
 * overtime-correct payroll math, timesheet exceptions and schedule conflicts.
 * Shared by server and client — no I/O. Calendar math is in `zoned.ts`.
 */
import { z } from "zod";
import {
  addDays,
  dayOfWeek,
  formatClock,
  hhmmMinutes,
  hhmmSchema,
  localDateOf,
  localDateSchema,
  minutesOfDay,
  weekStartOf,
  WEEKDAYS,
  type LocalDate,
  type Weekday,
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

export type EmployeeRole = { role: JobRole; hourlyRateCents: number; isPrimary: boolean };

/** The role the clock offers first: the matched shift's, else the primary, else the first. */
export function defaultRoleOf(roles: [EmployeeRole, ...EmployeeRole[]], matched: { role: JobRole } | null): JobRole {
  if (matched && roles.some((r) => r.role === matched.role)) return matched.role;
  return (roles.find((r) => r.isPrimary) ?? roles[0]).role;
}

// ---------------------------------------------------------------------------
// Store rules
// ---------------------------------------------------------------------------

export type StaffRules = {
  weekStartsOn: Weekday;
  otWeeklyMinutes: number;
  otDailyMinutes: number | null;
  dtDailyMinutes: number | null;
  breakRequiredAfterMinutes: number | null;
  clockGraceMinutes: number;
  earlyClockInMinutes: number | null;
};

export const DEFAULT_TIMEZONE = "America/Chicago";

type NumericRules = Omit<StaffRules, "weekStartsOn">;

const DEFAULT_NUMERIC_RULES = {
  otWeeklyMinutes: 2400,
  otDailyMinutes: null,
  dtDailyMinutes: null,
  breakRequiredAfterMinutes: 360,
  clockGraceMinutes: 7,
  earlyClockInMinutes: null,
} as const satisfies NumericRules;

export const DEFAULT_STAFF_RULES = { weekStartsOn: 1, ...DEFAULT_NUMERIC_RULES } as const satisfies StaffRules;

type NullableRuleKey = "otDailyMinutes" | "dtDailyMinutes" | "breakRequiredAfterMinutes" | "earlyClockInMinutes";
type RequiredRuleKey = "otWeeklyMinutes" | "clockGraceMinutes";

/** One numeric rule as a settings input. Hour fields are stored as minutes. */
export type StaffRuleField = (
  | { key: NullableRuleKey; nullable: true }
  /** Blank falls back to the default instead of turning the rule off. */
  | { key: RequiredRuleKey; nullable: false }
) & {
  name: string;
  id: string;
  label: string;
  unit: "h" | "min";
  /** Whether 0 turns the rule off rather than being a real value. */
  zeroIsOff: boolean;
  required: boolean;
  min: number;
  step: number;
  hint: string | null;
};

export const STAFF_RULE_FIELDS: readonly StaffRuleField[] = [
  { key: "otWeeklyMinutes", nullable: false, name: "otWeeklyHours", id: "s-ot-weekly", label: "Weekly overtime after (h)", unit: "h", zeroIsOff: true, required: true, min: 1, step: 0.5, hint: "40 under federal law." },
  { key: "breakRequiredAfterMinutes", nullable: true, name: "breakRequiredAfterHours", id: "s-break", label: "Flag no meal break after (h)", unit: "h", zeroIsOff: true, required: false, min: 0, step: 0.5, hint: "Flags the timesheet only; nothing is deducted." },
  { key: "otDailyMinutes", nullable: true, name: "otDailyHours", id: "s-ot-daily", label: "Daily overtime after (h)", unit: "h", zeroIsOff: true, required: false, min: 0, step: 0.5, hint: "California: 8. Blank for none." },
  { key: "dtDailyMinutes", nullable: true, name: "dtDailyHours", id: "s-dt-daily", label: "Daily double time after (h)", unit: "h", zeroIsOff: true, required: false, min: 0, step: 0.5, hint: "California: 12. Blank for none." },
  { key: "clockGraceMinutes", nullable: false, name: "clockGraceMinutes", id: "s-grace", label: "Late / early-out grace (min)", unit: "min", zeroIsOff: false, required: false, min: 0, step: 1, hint: null },
  { key: "earlyClockInMinutes", nullable: true, name: "earlyClockInMinutes", id: "s-early", label: "Block clock-in earlier than (min before shift)", unit: "min", zeroIsOff: true, required: false, min: 0, step: 1, hint: "Blank lets staff clock in any time. Managers can always add the time." },
];

/** The rule as its input shows it: hours for hour fields, blank when off. */
export function ruleInputValue(field: StaffRuleField, minutes: number | null): string {
  if (minutes === null) return "";
  return String(field.unit === "h" ? minutes / 60 : minutes);
}

/** Minutes typed into one rule input, or null when the input turns the rule off. */
function parseRule(field: StaffRuleField, raw: string): number | null {
  const value = field.unit === "h" ? Number.parseFloat(raw) : Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || (field.zeroIsOff && value <= 0)) return null;
  return field.unit === "h" ? Math.round(value * 60) : Math.max(0, value);
}

/** Reads every numeric rule from a settings form; `read` returns a field's raw text. */
export function parseStaffRules(read: (name: string) => string): NumericRules {
  const rules: NumericRules = { ...DEFAULT_NUMERIC_RULES };
  for (const field of STAFF_RULE_FIELDS) {
    const value = parseRule(field, read(field.name));
    if (field.nullable) rules[field.key] = value;
    else rules[field.key] = value ?? DEFAULT_NUMERIC_RULES[field.key];
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Kiosk requests
// ---------------------------------------------------------------------------

export const PIN_LENGTH = { min: 4, max: 6 } as const;
/** For `<input pattern>`. */
export const PIN_PATTERN = `\\d{${PIN_LENGTH.min},${PIN_LENGTH.max}}`;
export const pinSchema = z.string().regex(new RegExp(`^${PIN_PATTERN}$`), "A PIN is 4 to 6 digits.");

/** Longest reason, note or time-off reason a person can type. */
export const REASON_MAX = 500;

const clockInSchema = z.object({ type: z.literal("clock_in"), role: z.enum(JOB_ROLES) });
const startBreakSchema = z.object({ type: z.literal("start_break"), paid: z.boolean() });
const endBreakSchema = z.object({ type: z.literal("end_break") });
const clockOutSchema = z.object({ type: z.literal("clock_out"), declaredTipsCents: z.number().int().min(0).max(1_000_000) });
const timeOffActionSchema = z.object({
  type: z.literal("request_time_off"),
  startDate: localDateSchema,
  endDate: localDateSchema,
  reason: z.string().trim().max(REASON_MAX),
});

export const kioskRequestSchema = z.object({
  pin: pinSchema,
  action: z
    .discriminatedUnion("type", [clockInSchema, startBreakSchema, endBreakSchema, clockOutSchema, timeOffActionSchema])
    .optional(),
});

export type KioskRequest = z.infer<typeof kioskRequestSchema>;
export type KioskAction = NonNullable<KioskRequest["action"]>;
export type ClockAction = Exclude<KioskAction, { type: "request_time_off" }>;

/** Why time off can't be filed, or null. The kiosk passes today as `earliest`; a manager can backdate. */
export function timeOffProblem(start: LocalDate, end: LocalDate, earliest: LocalDate | null): string | null {
  if (earliest !== null && start < earliest) return "Time off has to start today or later.";
  if (end < start) return "The last day can't be before the first.";
  return null;
}

// ---------------------------------------------------------------------------
// Clock state machine
// ---------------------------------------------------------------------------

export type ClockState =
  | { kind: "off" }
  | { kind: "working"; entryId: number; role: JobRole; since: string }
  | { kind: "on_break"; entryId: number; breakId: number; paid: boolean; since: string };

/** An action narrowed to the state it applies to, carrying the rows it writes. */
export type ClockStep =
  | Extract<ClockAction, { type: "clock_in" }>
  | { type: "start_break"; entryId: number; paid: boolean }
  | { type: "end_break"; breakId: number }
  | { type: "clock_out"; entryId: number; declaredTipsCents: number };

export type ClockPlan = { kind: "apply"; step: ClockStep } | { kind: "replay" | "refuse"; message: string };

// Clock-out from a break is not offered: ending the break first keeps every
// break record closed.
export const ALLOWED: Record<ClockState["kind"], ClockAction["type"][]> = {
  off: ["clock_in"],
  working: ["start_break", "clock_out"],
  on_break: ["end_break"],
};

/**
 * The state each action leads to: finding the clock already there means a
 * retry. Clock-in applies from off and leads to both other states, so it is
 * always applied or replayed, never refused.
 */
const LEADS_TO: Record<Exclude<ClockAction["type"], "clock_in">, ClockState["kind"][]> = {
  start_break: ["on_break"],
  end_break: ["working"],
  clock_out: ["off"],
};

export const REPLAY_MESSAGE: Record<ClockAction["type"], string> = {
  clock_in: "You're already clocked in.",
  start_break: "You're already on a break.",
  end_break: "Your break already ended.",
  clock_out: "You're already clocked out.",
};

export const REFUSAL_MESSAGE: Record<Exclude<ClockAction["type"], "clock_in">, string> = {
  start_break: "Clock in before starting a break.",
  end_break: "You're not on a break.",
  clock_out: "End your break before clocking out.",
};

function stepFor(state: ClockState, action: ClockAction): ClockStep | null {
  switch (state.kind) {
    case "off":
      return action.type === "clock_in" ? action : null;
    case "working":
      if (action.type === "start_break") return { type: "start_break", entryId: state.entryId, paid: action.paid };
      if (action.type === "clock_out") return { ...action, entryId: state.entryId };
      return null;
    case "on_break":
      return action.type === "end_break" ? { type: "end_break", breakId: state.breakId } : null;
  }
}

/**
 * Whether an action applies to the current state. A double tap or a retried
 * request finds the clock already where the action leads; that is a replay,
 * answered with the current view rather than an error or a second row.
 */
export function planClock(state: ClockState, action: ClockAction): ClockPlan {
  const step = stepFor(state, action);
  if (step) return { kind: "apply", step };
  if (action.type === "clock_in" || LEADS_TO[action.type].includes(state.kind)) {
    return { kind: "replay", message: REPLAY_MESSAGE[action.type] };
  }
  return { kind: "refuse", message: REFUSAL_MESSAGE[action.type] };
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

/** Whole minutes from one instant to a later one. */
export function elapsedMinutes(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MINUTE));
}

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

/** A punch with its store-local date and minutes. */
export type PunchPay<E extends PayEntry = PayEntry> = E & { date: LocalDate; paidMinutes: number; breakMinutes: number };

export type WeekPay<E extends PayEntry = PayEntry> = {
  days: DayPay[];
  totals: Omit<DayPay, "date">;
  /** Sorted by clock-in. */
  entries: PunchPay<E>[];
  straightCents: number;
  premiumCents: number;
  grossCents: number;
  tipsCents: number;
};

const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);

/** a / b rounded half up, for non-negative integers. */
function roundDiv(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b));
}

/** Straight pay in cent-minutes per hour: Σ minutes × hourly cents, unrounded. */
const centMinutes = (punches: { paidMinutes: number; rateCents: number }[]) =>
  sum(punches, (p) => p.paidMinutes * p.rateCents);

/** Straight-time labor cost of these punches, counted up to now, rounded once. */
export function laborCents(entries: PayEntry[], now: Date): number {
  return roundDiv(centMinutes(entries.map((e) => ({ rateCents: e.rateCents, ...entryMinutes(e, now) }))), 60);
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
export function computeWeek<E extends PayEntry>(
  entries: E[],
  rules: Pick<StaffRules, "otWeeklyMinutes" | "otDailyMinutes" | "dtDailyMinutes">,
  tz: string,
  now: Date,
): WeekPay<E> {
  const punches: PunchPay<E>[] = entries
    .toSorted((a, b) => a.clockInAt.getTime() - b.clockInAt.getTime())
    .map((e) => ({ ...e, date: localDateOf(e.clockInAt, tz), ...entryMinutes(e, now) }));
  const otCap = rules.otDailyMinutes ?? Infinity;
  const dtCap = rules.dtDailyMinutes ?? Infinity;

  // Punches are sorted by clock-in, so groups come out in date order.
  let weekRegular = 0;
  const days: DayPay[] = [...Map.groupBy(punches, (p) => p.date)].map(([date, ps]) => {
    const paid = sum(ps, (p) => p.paidMinutes);
    const dt = Math.max(0, paid - dtCap);
    const dailyOt = Math.max(0, Math.min(paid, dtCap) - otCap);
    const weeklyOt = Math.max(0, paid - dt - dailyOt - (rules.otWeeklyMinutes - weekRegular));
    const regular = paid - dt - dailyOt - weeklyOt;
    weekRegular += regular;
    return { date, paidMinutes: paid, regularMinutes: regular, otMinutes: dailyOt + weeklyOt, dtMinutes: dt, breakMinutes: sum(ps, (p) => p.breakMinutes) };
  });
  const totals = {
    paidMinutes: sum(days, (d) => d.paidMinutes),
    regularMinutes: sum(days, (d) => d.regularMinutes),
    otMinutes: sum(days, (d) => d.otMinutes),
    dtMinutes: sum(days, (d) => d.dtMinutes),
    breakMinutes: sum(days, (d) => d.breakMinutes),
  };

  const straight = centMinutes(punches);
  const straightCents = roundDiv(straight, 60);
  const t = totals.paidMinutes;
  // straight/60 + (OT × ½ + DT × 1) × straight / (60 × total), over one denominator.
  const grossCents = t === 0 ? 0 : roundDiv(straight * (2 * t + totals.otMinutes + 2 * totals.dtMinutes), 120 * t);

  return {
    days,
    totals,
    entries: punches,
    straightCents,
    premiumCents: grossCents - straightCents,
    grossCents,
    tipsCents: sum(punches, (p) => p.declaredTipsCents),
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

/** `attention`: whether the overview counts it as something to fix. */
export const FLAG_META: Record<EntryFlag, { label: string; severity: Severity; attention: boolean }> = {
  missed_clock_out: { label: "Missed clock-out", severity: "critical", attention: true },
  on_break_long: { label: "Break over an hour", severity: "warning", attention: true },
  no_break: { label: "No meal break", severity: "warning", attention: true },
  late: { label: "Late", severity: "warning", attention: true },
  early_out: { label: "Left early", severity: "info", attention: true },
  unscheduled: { label: "Unscheduled", severity: "info", attention: true },
  edited: { label: "Edited", severity: "info", attention: false },
};

const MISSED_CLOCK_OUT_MS = 14 * 60 * MINUTE;
const LONG_BREAK_MS = 60 * MINUTE;

/** Past the grace period after a shift's start. */
export function isLate(shiftStart: Date, at: Date, rules: Pick<StaffRules, "clockGraceMinutes">): boolean {
  return at.getTime() > shiftStart.getTime() + rules.clockGraceMinutes * MINUTE;
}

export function entryFlags(
  entry: PayEntry & { edited: boolean },
  shift: { startsAt: Date; endsAt: Date } | null,
  rules: Pick<StaffRules, "breakRequiredAfterMinutes" | "clockGraceMinutes">,
  now: Date,
): EntryFlag[] {
  const flags: EntryFlag[] = [];
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
    if (isLate(shift.startsAt, entry.clockInAt, rules)) flags.push("late");
    if (
      entry.clockOutAt !== null &&
      entry.clockOutAt.getTime() < shift.endsAt.getTime() - rules.clockGraceMinutes * MINUTE
    ) {
      flags.push("early_out");
    }
  }
  if (entry.edited) flags.push("edited");
  return flags;
}

export const TIME_AUDIT_ACTIONS = ["create", "edit", "delete", "approve", "unapprove", "clock_out"] as const;
export type TimeAuditAction = (typeof TIME_AUDIT_ACTIONS)[number];

/** Audit actions that changed the punch's time, as opposed to signing it off. */
const EDIT_ACTIONS: readonly TimeAuditAction[] = ["create", "edit", "clock_out"];

export const wasEdited = (audit: { action: TimeAuditAction }[]) => audit.some((a) => EDIT_ACTIONS.includes(a.action));

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export type DayRule = { kind: "any" } | { kind: "none" } | { kind: "window"; from: string; to: string };

export type WeeklyAvailability = Record<Weekday, DayRule>;

const ANY: DayRule = { kind: "any" };
export const ANY_TIME: WeeklyAvailability = { 0: ANY, 1: ANY, 2: ANY, 3: ANY, 4: ANY, 5: ANY, 6: ANY };

const storedAvailabilitySchema = z.array(
  z.discriminatedUnion("kind", [
    z.object({ day: z.number().int().min(0).max(6), kind: z.literal("any") }),
    z.object({ day: z.number().int().min(0).max(6), kind: z.literal("none") }),
    z.object({ day: z.number().int().min(0).max(6), kind: z.literal("window"), from: hhmmSchema, to: hhmmSchema }),
  ]),
);

/** The `employees.availability` jsonb: one entry per restricted weekday, or null for any time. */
export type StoredAvailability = z.infer<typeof storedAvailabilitySchema>;

/** Parses the stored column. A missing day, a null column or an unreadable one is any time. */
export function availabilityFromStored(stored: unknown): WeeklyAvailability {
  const parsed = storedAvailabilitySchema.safeParse(stored);
  if (!parsed.success) return ANY_TIME;
  const week = { ...ANY_TIME };
  for (const { day, ...rule } of parsed.data) {
    week[WEEKDAYS[day]] = rule;
  }
  return week;
}

export function availabilityToStored(week: WeeklyAvailability): StoredAvailability | null {
  if (WEEKDAYS.every((d) => week[d].kind === "any")) return null;
  return WEEKDAYS.map((day) => ({ day, ...week[day] }));
}

export type ShiftTimes = {
  id: number | null;
  startsAt: Date;
  endsAt: Date;
  unpaidBreakMinutes: number;
};

export type LiveTimeOffStatus = "pending" | "approved";

/** Time off that still counts: denied requests are dropped when the row is read. */
export type TimeOffLike = {
  startDate: LocalDate;
  endDate: LocalDate;
  status: LiveTimeOffStatus;
};

export const MAX_SHIFT_MINUTES = 16 * 60;

/** Why a shift can't be saved, or null. */
export function shiftProblem(shift: Omit<ShiftTimes, "id">): string | null {
  const minutes = (shift.endsAt.getTime() - shift.startsAt.getTime()) / MINUTE;
  if (minutes > MAX_SHIFT_MINUTES) return "A shift can be at most 16 hours.";
  if (shift.unpaidBreakMinutes >= minutes) return "The break is longer than the shift.";
  return null;
}

export function shiftPaidMinutes(shift: Omit<ShiftTimes, "id">): number {
  const minutes = Math.round((shift.endsAt.getTime() - shift.startsAt.getTime()) / MINUTE);
  return Math.max(0, minutes - shift.unpaidBreakMinutes);
}

export function shiftCostCents(shift: Omit<ShiftTimes, "id">, rateCents: number): number {
  return Math.round((shiftPaidMinutes(shift) * rateCents) / 60);
}

/** Scheduled minutes still to come: whole shifts ahead, and the rest of any under way. */
export function remainingShiftMinutes(shifts: Omit<ShiftTimes, "id">[], now: Date): number {
  return sum(
    shifts.filter((s) => s.endsAt > now),
    (s) => (s.startsAt > now ? shiftPaidMinutes(s) : Math.floor((s.endsAt.getTime() - now.getTime()) / MINUTE)),
  );
}

/** Scheduled or worked minutes past the weekly overtime threshold. */
export function isOvertime(weekMinutes: number, rules: Pick<StaffRules, "otWeeklyMinutes">): boolean {
  return weekMinutes > rules.otWeeklyMinutes;
}

/** How close to the weekly threshold counts as overtime risk. */
export const OT_RISK_MARGIN_MINUTES = 120;

export function atOvertimeRisk(projectedMinutes: number, rules: Pick<StaffRules, "otWeeklyMinutes">): boolean {
  return isOvertime(projectedMinutes + OT_RISK_MARGIN_MINUTES, rules);
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

/** The store-local dates a shift touches (an overnight close touches two; one ending at midnight, one). */
export function shiftDates(shift: Pick<ShiftTimes, "startsAt" | "endsAt">, tz: string): [LocalDate, LocalDate] {
  return [localDateOf(shift.startsAt, tz), localDateOf(new Date(shift.endsAt.getTime() - 1), tz)];
}

/** Whether a shift lands on any day of a time-off request. */
export function shiftTouchesTimeOff(
  shift: Pick<ShiftTimes, "startsAt" | "endsAt">,
  timeOff: Pick<TimeOffLike, "startDate" | "endDate">,
  tz: string,
): boolean {
  const [first, last] = shiftDates(shift, tz);
  return timeOff.startDate <= last && timeOff.endDate >= first;
}

function outsideAvailability(shift: ShiftTimes, availability: WeeklyAvailability, tz: string): boolean {
  const [date] = shiftDates(shift, tz);
  const a = availability[dayOfWeek(date)];
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
  availability: WeeklyAvailability,
  rules: Pick<StaffRules, "otWeeklyMinutes" | "weekStartsOn">,
  tz: string,
): ShiftConflict[] {
  const others = sameEmployeeShifts.filter((s) => s.id === null || s.id !== shift.id);
  const conflicts: ShiftConflict[] = [];
  if (others.some((s) => s.startsAt < shift.endsAt && s.endsAt > shift.startsAt)) conflicts.push("overlap");

  const touching = timeOff.filter((t) => shiftTouchesTimeOff(shift, t, tz));
  if (touching.some((t) => t.status === "approved")) conflicts.push("time_off");
  if (touching.some((t) => t.status === "pending")) conflicts.push("time_off_pending");

  if (outsideAvailability(shift, availability, tz)) conflicts.push("unavailable");

  const week = weekStartOf(localDateOf(shift.startsAt, tz), rules.weekStartsOn);
  const weekMinutes = sum(
    [shift, ...others].filter((s) => weekStartOf(localDateOf(s.startsAt, tz), rules.weekStartsOn) === week),
    shiftPaidMinutes,
  );
  if (isOvertime(weekMinutes, rules)) conflicts.push("overtime");
  return conflicts;
}

/** How long before a shift's start a punch still belongs to it. */
export const MATCH_EARLY_MS = 2 * 60 * MINUTE;

/** Whether a punch belongs to a shift: [start − 2 h, end] contains its clock-in. */
export function punchFitsShift(clockIn: Date, shift: Pick<ShiftTimes, "startsAt" | "endsAt">): boolean {
  const t = clockIn.getTime();
  return t >= shift.startsAt.getTime() - MATCH_EARLY_MS && t <= shift.endsAt.getTime();
}

/** The published shift a punch belongs to, nearest start first. */
export function matchShift<S extends Pick<ShiftTimes, "startsAt" | "endsAt">>(
  clockIn: Date,
  shifts: S[],
): S | null {
  const t = clockIn.getTime();
  const candidates = shifts.filter((s) => punchFitsShift(clockIn, s));
  candidates.sort((a, b) => Math.abs(a.startsAt.getTime() - t) - Math.abs(b.startsAt.getTime() - t));
  return candidates[0] ?? null;
}

/**
 * The published shifts that can matter to a punch at `at`: any it could
 * belong to, and today's next one for the early clock-in rule.
 */
export function shiftLookupWindow(at: Date): { from: Date; to: Date } {
  return { from: new Date(at.getTime() - 14 * 60 * MINUTE), to: new Date(at.getTime() + 24 * 60 * MINUTE) };
}

/**
 * Today's shifts past their grace period with no punch: none linked to the
 * shift, and none from the same person that fits its window.
 */
export function lateShifts<S extends { id: number; employeeId: number | null; startsAt: Date; endsAt: Date }>(
  shifts: S[],
  punches: { employeeId: number; shiftId: number | null; clockInAt: Date }[],
  rules: Pick<StaffRules, "clockGraceMinutes">,
  now: Date,
  tz: string,
): S[] {
  const today = localDateOf(now, tz);
  return shifts.filter(
    (shift) =>
      localDateOf(shift.startsAt, tz) === today &&
      isLate(shift.startsAt, now, rules) &&
      !punches.some(
        (p) => p.employeeId === shift.employeeId && (p.shiftId === shift.id || punchFitsShift(p.clockInAt, shift)),
      ),
  );
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

/** Whether this person may clock in as `role` now, and at which rate. */
export function checkClockIn(
  roles: Pick<EmployeeRole, "role" | "hourlyRateCents">[],
  role: JobRole,
  nearbyShifts: Pick<ShiftTimes, "startsAt" | "endsAt">[],
  rules: Pick<StaffRules, "earlyClockInMinutes">,
  now: Date,
  tz: string,
): { ok: true; rateCents: number } | { ok: false; message: string } {
  const match = roles.find((r) => r.role === role);
  if (!match) return { ok: false, message: "Pick one of your roles. A manager can add roles for you." };
  const block = earlyClockInBlock(now, nearbyShifts, rules, tz);
  if (block) {
    return {
      ok: false,
      message: `Your shift starts at ${formatClock(block.shift.startsAt, tz)}. You can clock in from ${formatClock(block.opensAt, tz)}.`,
    };
  }
  return { ok: true, rateCents: match.hourlyRateCents };
}

/** Splits published shifts into today's and the next seven days'. */
export function kioskShiftDays<S extends { startsAt: Date }>(
  shifts: S[],
  today: LocalDate,
  tz: string,
): { today: S[]; upcoming: S[] } {
  const dated = shifts.map((s) => ({ s, date: localDateOf(s.startsAt, tz) }));
  const weekOut = addDays(today, 7);
  return {
    today: dated.filter((d) => d.date === today).map((d) => d.s),
    upcoming: dated.filter((d) => d.date > today && d.date <= weekOut).map((d) => d.s),
  };
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

/** 450 → "7.50 h", for display. */
export function formatHours(minutes: number): string {
  return `${decimalHours(minutes)} h`;
}

/** Labor cost as a percent of sales; null without sales to compare. */
export function laborPercent(laborCents: number, salesCents: number | null): number | null {
  return salesCents === null || salesCents === 0 ? null : (laborCents / salesCents) * 100;
}

/** 23.456 → "23.5%", null → "–". */
export function formatPercent(percent: number | null): string {
  return percent === null ? "–" : `${percent.toFixed(1)}%`;
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

export function snapshotOf(e: Omit<PayEntry, "id"> & { note: string | null }): AuditSnapshot {
  return {
    role: e.role,
    rateCents: e.rateCents,
    clockInAt: e.clockInAt.toISOString(),
    clockOutAt: e.clockOutAt?.toISOString() ?? null,
    declaredTipsCents: e.declaredTipsCents,
    note: e.note,
    breaks: e.breaks
      .toSorted((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .map((b) => ({ startedAt: b.startedAt.toISOString(), endedAt: b.endedAt?.toISOString() ?? null, paid: b.paid })),
  };
}

/** An employee as the shift and punch pickers list them. */
export type StaffOption = { id: number; name: string; roles: JobRole[]; primary: JobRole | null };

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
  timeOff: { id: number; startDate: LocalDate; endDate: LocalDate; status: LiveTimeOffStatus }[];
};

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
