"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOperator } from "@/lib/auth";
import { centsField, checkbox, idField, optionalIdField, textField, textOrNull } from "@/lib/form-data";
import {
  ANY_TIME,
  availabilityToStored,
  JOB_ROLES,
  pinSchema,
  REASON_MAX,
  timeOffProblem,
  type EmployeeRole,
  type JobRole,
  type StoredAvailability,
  type WeeklyAvailability,
} from "@/lib/timeclock";
import { getStaffConfig, resolveWeek } from "@/lib/staff/config";
import { POS_ACCESS_LEVELS } from "@/lib/pos-access";
import * as staffEmployees from "@/lib/staff/employees";
import * as schedule from "@/lib/staff/schedule";
import { decideTimeOff, requestTimeOff } from "@/lib/staff/time-off";
import { approveWeek, deleteManagerPunch, managerClockOut, saveManagerPunch } from "@/lib/staff/timesheets";
import { DAY_NAMES, fromLocalInput, hhmmSchema, localDateSchema, WEEKDAYS } from "@/lib/zoned";

export type StaffFormState = { error?: string; savedId?: number; pin?: string; notice?: string };

function revalidateStaff(): void {
  revalidatePath("/admin/staff", "layout");
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Please check the form and retry.";
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

const employeeSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  phone: z.string().trim().max(25),
  email: z.union([z.literal(""), z.email("Enter a valid email").max(200)]),
  hiredOn: z.union([z.literal(""), localDateSchema]),
  notes: z.string().trim().max(1000),
});

function rolesFrom(fd: FormData): [EmployeeRole, ...EmployeeRole[]] | string {
  const chosen = JOB_ROLES.filter((r) => checkbox(fd, `role-${r}`));
  const primaryField = textField(fd, "primaryRole");
  const primary = chosen.includes(primaryField as JobRole) ? primaryField : chosen[0];
  const roles: EmployeeRole[] = [];
  for (const role of chosen) {
    const hourlyRateCents = centsField(fd, `rate-${role}`);
    if (hourlyRateCents === null) return "Enter each hourly rate in dollars, like 15.50.";
    roles.push({ role, hourlyRateCents, isPrimary: role === primary });
  }
  const [first, ...rest] = roles;
  return first ? [first, ...rest] : "Give them at least one role.";
}

function availabilityFrom(fd: FormData): StoredAvailability | null | string {
  const week: WeeklyAvailability = { ...ANY_TIME };
  for (const d of WEEKDAYS) {
    const kind = textField(fd, `avail-${d}`);
    if (kind === "none") week[d] = { kind: "none" };
    else if (kind === "window") {
      const from = hhmmSchema.safeParse(textField(fd, `from-${d}`));
      const to = hhmmSchema.safeParse(textField(fd, `to-${d}`));
      if (!from.success || !to.success) return `Set both times for ${DAY_NAMES[d]}.`;
      week[d] = { kind: "window", from: from.data, to: to.data };
    }
  }
  return availabilityToStored(week);
}

/** undefined = leave the PIN alone. */
async function pinFrom(fd: FormData): Promise<string | undefined | { error: string }> {
  if (textField(fd, "pinAction") === "generate") return staffEmployees.generatePin();
  const pin = textField(fd, "pin");
  if (pin === "") return undefined;
  const parsed = pinSchema.safeParse(pin);
  return parsed.success ? parsed.data : { error: firstIssue(parsed.error) };
}

/** Creates (no `employeeId`) or updates an employee with roles, availability and PIN. */
export async function saveEmployee(_prev: StaffFormState, fd: FormData): Promise<StaffFormState> {
  await requireOperator();
  const parsed = employeeSchema.safeParse({
    name: textField(fd, "name"),
    phone: textField(fd, "phone"),
    email: textField(fd, "email").toLowerCase(),
    hiredOn: textField(fd, "hiredOn"),
    notes: textField(fd, "notes"),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const roles = rolesFrom(fd);
  if (typeof roles === "string") return { error: roles };
  const availability = availabilityFrom(fd);
  if (typeof availability === "string") return { error: availability };
  const pin = await pinFrom(fd);
  if (typeof pin === "object") return pin;

  const existingId = optionalIdField(fd, "employeeId");
  const saved = await staffEmployees.saveEmployee(existingId, {
    name: parsed.data.name,
    phone: parsed.data.phone || null,
    email: parsed.data.email || null,
    hiredOn: parsed.data.hiredOn || null,
    notes: parsed.data.notes || null,
    availability,
    roles,
    posAccess: z.enum(POS_ACCESS_LEVELS).catch("none").parse(textField(fd, "posAccess")),
    pin,
  });
  if ("error" in saved) return saved;
  revalidateStaff();
  return { savedId: saved.id, pin, notice: existingId === null ? `${parsed.data.name} was added.` : "Saved." };
}

export async function setEmployeeActive(fd: FormData): Promise<void> {
  await requireOperator();
  const id = idField(fd, "employeeId");
  const notice = await staffEmployees.setEmployeeActive(id, textField(fd, "active") === "true");
  revalidateStaff();
  redirect(`/admin/staff/employees/${id}?notice=${notice}`);
}

export async function removeEmployeePin(fd: FormData): Promise<void> {
  await requireOperator();
  const id = idField(fd, "employeeId");
  await staffEmployees.removeEmployeePin(id);
  revalidateStaff();
  redirect(`/admin/staff/employees/${id}?notice=pin-removed`);
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

const shiftSchema = z.object({
  role: z.enum(JOB_ROLES, "Pick a role."),
  date: localDateSchema,
  start: hhmmSchema,
  end: hhmmSchema,
  unpaidBreakMinutes: z.coerce.number().int().min(0).max(240),
  notes: z.string().trim().max(REASON_MAX),
});

export async function saveShift(_prev: StaffFormState, fd: FormData): Promise<StaffFormState> {
  await requireOperator();
  const parsed = shiftSchema.safeParse({
    role: textField(fd, "role"),
    date: textField(fd, "date"),
    start: textField(fd, "start"),
    end: textField(fd, "end"),
    unpaidBreakMinutes: textField(fd, "unpaidBreakMinutes") || "0",
    notes: textField(fd, "notes"),
  });
  if (!parsed.success) return { error: "Check the date, times and break." };
  const shiftId = optionalIdField(fd, "shiftId");
  const result = await schedule.saveShift(
    { ...parsed.data, notes: parsed.data.notes || null, shiftId, employeeId: optionalIdField(fd, "employeeId") },
    await getStaffConfig(),
  );
  if (result.error) return result;
  revalidateStaff();
  return { notice: "Saved.", savedId: shiftId ?? undefined };
}

export async function deleteShift(fd: FormData): Promise<void> {
  await requireOperator();
  await schedule.deleteShift(idField(fd, "shiftId"));
  revalidateStaff();
}

export async function copyLastWeek(fd: FormData): Promise<void> {
  await requireOperator();
  const cfg = await getStaffConfig();
  const week = resolveWeek(textField(fd, "week"), cfg);
  const copied = await schedule.copyPreviousWeek(week, cfg);
  revalidateStaff();
  redirect(`/admin/staff/schedule?week=${week}&copied=${copied}`);
}

export async function publishSchedule(fd: FormData): Promise<void> {
  await requireOperator();
  const cfg = await getStaffConfig();
  const week = resolveWeek(textField(fd, "week"), cfg);
  const published = await schedule.publishWeek(week, cfg);
  revalidateStaff();
  redirect(`/admin/staff/schedule?week=${week}&published=${published}`);
}

// ---------------------------------------------------------------------------
// Timesheets (every change to time carries a reason)
// ---------------------------------------------------------------------------

const reasonSchema = z.string().trim().min(1, "Give a reason for the change.").max(REASON_MAX);

export async function savePunch(_prev: StaffFormState, fd: FormData): Promise<StaffFormState> {
  const operator = await requireOperator();
  const reason = reasonSchema.safeParse(textField(fd, "reason"));
  if (!reason.success) return { error: firstIssue(reason.error) };
  const role = z.enum(JOB_ROLES).safeParse(textField(fd, "role"));
  if (!role.success) return { error: "Pick a role." };
  const { timezone } = await getStaffConfig();
  const wallClock = (name: string) => fromLocalInput(textField(fd, name), timezone);

  const clockInAt = wallClock("clockIn");
  const clockOutAt = wallClock("clockOut");
  if (clockInAt === null || clockInAt === "invalid" || clockOutAt === "invalid") return { error: "Check the clock-in and clock-out times." };
  const breaks = [];
  const count = Math.min(10, Number.parseInt(textField(fd, "breakCount"), 10) || 0);
  for (let i = 0; i < count; i++) {
    const startedAt = wallClock(`break-start-${i}`);
    const endedAt = wallClock(`break-end-${i}`);
    if (startedAt === null) continue;
    if (startedAt === "invalid" || endedAt === "invalid") return { error: "Check the break times." };
    breaks.push({ startedAt, endedAt, paid: checkbox(fd, `break-paid-${i}`) });
  }
  const declaredTipsCents = centsField(fd, "tips");
  if (declaredTipsCents === null) return { error: "Enter tips in dollars, like 12.50." };

  const result = await saveManagerPunch(
    {
      entryId: optionalIdField(fd, "entryId"),
      employeeId: idField(fd, "employeeId"),
      role: role.data,
      clockInAt,
      clockOutAt,
      breaks,
      declaredTipsCents,
      note: textOrNull(fd, "note"),
      reason: reason.data,
    },
    operator.id,
  );
  if (result.error) return result;
  revalidateStaff();
  return { notice: "Saved." };
}

export async function deletePunch(fd: FormData): Promise<void> {
  const operator = await requireOperator();
  await deleteManagerPunch(idField(fd, "entryId"), operator.id, reasonSchema.parse(textField(fd, "reason")));
  revalidateStaff();
}

/** Closes a forgotten punch now (overview's "Clock out"). */
export async function clockOutForEmployee(fd: FormData): Promise<void> {
  const operator = await requireOperator();
  await managerClockOut(idField(fd, "entryId"), operator.id, reasonSchema.parse(textField(fd, "reason")));
  revalidateStaff();
}

/** Approves one employee's week (`employeeId`) or everyone's. */
export async function approveTimesheet(fd: FormData): Promise<void> {
  const operator = await requireOperator();
  const cfg = await getStaffConfig();
  const week = resolveWeek(textField(fd, "week"), cfg);
  const approved = await approveWeek(week, optionalIdField(fd, "employeeId"), operator.id, cfg);
  revalidateStaff();
  redirect(`/admin/staff/timesheets?week=${week}&approved=${approved}`);
}

// ---------------------------------------------------------------------------
// Time off
// ---------------------------------------------------------------------------

export async function decideTimeOffRequest(fd: FormData): Promise<void> {
  const operator = await requireOperator();
  const decision = z.enum(["approved", "denied"]).parse(textField(fd, "decision"));
  await decideTimeOff(idField(fd, "requestId"), decision, operator.id);
  revalidateStaff();
}

/** Time off a manager enters for someone is approved on the spot. */
export async function addTimeOff(_prev: StaffFormState, fd: FormData): Promise<StaffFormState> {
  const operator = await requireOperator();
  const start = localDateSchema.safeParse(textField(fd, "startDate"));
  const end = localDateSchema.safeParse(textField(fd, "endDate") || textField(fd, "startDate"));
  if (!start.success || !end.success) return { error: "Pick the first and last day." };
  const problem = timeOffProblem(start.data, end.data, null);
  if (problem) return { error: problem };
  await requestTimeOff(
    { employeeId: idField(fd, "employeeId"), startDate: start.data, endDate: end.data, reason: textOrNull(fd, "reason") },
    { kind: "manager", operatorId: operator.id },
  );
  revalidateStaff();
  return { notice: "Time off added." };
}
