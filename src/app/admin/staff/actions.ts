"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, gte, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db, employeeRoles, employees, shifts, timeEntries } from "@/db";
import { requireOperator } from "@/lib/auth";
import { checkbox, dollarsToCents, idField, textField, textOrNull } from "@/lib/form-data";
import { ANY_TIME, availabilityToStored, JOB_ROLES, ROLE_LABEL, type JobRole, type StoredAvailability, type WeeklyAvailability } from "@/lib/timeclock";
import { isUniqueViolation } from "@/db/errors";
import { getStaffConfig, resolveWeek } from "@/lib/staff/config";
import { generatePin, pinDigest } from "@/lib/staff/employees";
import { copyPreviousWeek, publishWeek } from "@/lib/staff/schedule";
import { decideTimeOff, requestTimeOff } from "@/lib/staff/time-off";
import { approveWeek, deleteManagerPunch, managerClockOut, saveManagerPunch } from "@/lib/staff/timesheets";
import { DAY_NAMES, hhmmSchema, localDateSchema, shiftInstants, WEEKDAYS, zonedInstant } from "@/lib/zoned";

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

type RoleInput = { role: JobRole; hourlyRateCents: number; isPrimary: boolean };

function rolesFrom(fd: FormData): RoleInput[] | string {
  const chosen = JOB_ROLES.filter((r) => checkbox(fd, `role-${r}`));
  if (chosen.length === 0) return "Give them at least one role.";
  const primaryField = textField(fd, "primaryRole");
  const primary = chosen.includes(primaryField as JobRole) ? primaryField : chosen[0];
  try {
    return chosen.map((role) => ({ role, hourlyRateCents: dollarsToCents(fd, `rate-${role}`), isPrimary: role === primary }));
  } catch {
    return "Enter each hourly rate in dollars, like 15.50.";
  }
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
  if (textField(fd, "pinAction") === "generate") return generatePin();
  const pin = textField(fd, "pin");
  if (pin === "") return undefined;
  return /^\d{4,6}$/.test(pin) ? pin : { error: "A PIN is 4 to 6 digits." };
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

  const values = {
    name: parsed.data.name,
    phone: parsed.data.phone || null,
    email: parsed.data.email || null,
    hiredOn: parsed.data.hiredOn || null,
    notes: parsed.data.notes || null,
    availability,
    ...(pin === undefined ? {} : { pinDigest: pinDigest(pin) }),
    updatedAt: new Date(),
  };
  const existingId = textField(fd, "employeeId") === "" ? null : idField(fd, "employeeId");

  try {
    if (existingId === null) {
      const [created] = await db.insert(employees).values(values).returning({ id: employees.id });
      await db.insert(employeeRoles).values(roles.map((r) => ({ ...r, employeeId: created.id })));
      revalidateStaff();
      return { savedId: created.id, pin, notice: `${values.name} was added.` };
    }
    const kept = roles.map((r) => r.role);
    await db.batch([
      db.update(employees).set(values).where(eq(employees.id, existingId)),
      db.delete(employeeRoles).where(and(eq(employeeRoles.employeeId, existingId), notInArray(employeeRoles.role, kept))),
      ...roles.map((r) =>
        db
          .insert(employeeRoles)
          .values({ ...r, employeeId: existingId })
          .onConflictDoUpdate({
            target: [employeeRoles.employeeId, employeeRoles.role],
            set: { hourlyRateCents: r.hourlyRateCents, isPrimary: r.isPrimary },
          }),
      ),
    ]);
  } catch (error) {
    // pin_digest is the only unique column a save can collide on.
    if (isUniqueViolation(error)) return { error: "Someone else already has that PIN. Pick another." };
    throw error;
  }
  revalidateStaff();
  return { savedId: existingId, pin, notice: "Saved." };
}

/**
 * Archiving takes someone off the clock and the schedule but keeps every
 * punch for payroll. Their upcoming shifts become open shifts to fill.
 */
export async function setEmployeeActive(fd: FormData): Promise<void> {
  await requireOperator();
  const id = idField(fd, "employeeId");
  const active = textField(fd, "active") === "true";
  if (!active) {
    const [open] = await db
      .select({ id: timeEntries.id })
      .from(timeEntries)
      .where(and(eq(timeEntries.employeeId, id), isNull(timeEntries.clockOutAt)));
    if (open) redirect(`/admin/staff/employees/${id}?notice=on-clock`);
    await db.batch([
      db.update(employees).set({ isActive: false, updatedAt: new Date() }).where(eq(employees.id, id)),
      db
        .update(shifts)
        .set({ employeeId: null, updatedAt: new Date() })
        .where(and(eq(shifts.employeeId, id), gte(shifts.startsAt, new Date()))),
    ]);
  } else {
    await db.update(employees).set({ isActive: true, updatedAt: new Date() }).where(eq(employees.id, id));
  }
  revalidateStaff();
  redirect(`/admin/staff/employees/${id}?notice=${active ? "restored" : "archived"}`);
}

export async function removeEmployeePin(fd: FormData): Promise<void> {
  await requireOperator();
  const id = idField(fd, "employeeId");
  await db.update(employees).set({ pinDigest: null, updatedAt: new Date() }).where(eq(employees.id, id));
  revalidateStaff();
  redirect(`/admin/staff/employees/${id}?notice=pin-removed`);
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

const MAX_SHIFT_MINUTES = 16 * 60;

const shiftSchema = z.object({
  role: z.enum(JOB_ROLES, "Pick a role."),
  date: localDateSchema,
  start: hhmmSchema,
  end: hhmmSchema,
  unpaidBreakMinutes: z.coerce.number().int().min(0).max(240),
  notes: z.string().trim().max(500),
});

/**
 * Creates or edits a shift. New shifts are drafts until the week is
 * published; an edit keeps the shift's published state, so staff see the
 * change at once.
 */
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
  const { role, date, start, end, unpaidBreakMinutes, notes } = parsed.data;
  const employeeId = textField(fd, "employeeId") === "" ? null : idField(fd, "employeeId");
  if (employeeId !== null) {
    const [has] = await db
      .select({ id: employeeRoles.id })
      .from(employeeRoles)
      .where(and(eq(employeeRoles.employeeId, employeeId), eq(employeeRoles.role, role)));
    if (!has) return { error: `They don't work as ${ROLE_LABEL[role]}. Add the role on their profile first.` };
  }
  const { timezone } = await getStaffConfig();
  const { startsAt, endsAt } = shiftInstants(date, start, end, timezone);
  const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
  if (minutes > MAX_SHIFT_MINUTES) return { error: "A shift can be at most 16 hours." };
  if (unpaidBreakMinutes >= minutes) return { error: "The break is longer than the shift." };

  const values = { employeeId, role, startsAt, endsAt, unpaidBreakMinutes, notes: notes || null, updatedAt: new Date() };
  const shiftId = textField(fd, "shiftId") === "" ? null : idField(fd, "shiftId");
  if (shiftId === null) await db.insert(shifts).values(values);
  else await db.update(shifts).set(values).where(eq(shifts.id, shiftId));
  revalidateStaff();
  return { notice: "Saved.", savedId: shiftId ?? undefined };
}

export async function deleteShift(fd: FormData): Promise<void> {
  await requireOperator();
  await db.delete(shifts).where(eq(shifts.id, idField(fd, "shiftId")));
  revalidateStaff();
}

export async function copyLastWeek(fd: FormData): Promise<void> {
  await requireOperator();
  const cfg = await getStaffConfig();
  const week = resolveWeek(textField(fd, "week"), cfg);
  const copied = await copyPreviousWeek(week, cfg);
  revalidateStaff();
  redirect(`/admin/staff/schedule?week=${week}&copied=${copied}`);
}

export async function publishSchedule(fd: FormData): Promise<void> {
  await requireOperator();
  const cfg = await getStaffConfig();
  const week = resolveWeek(textField(fd, "week"), cfg);
  const published = await publishWeek(week, cfg);
  revalidateStaff();
  redirect(`/admin/staff/schedule?week=${week}&published=${published}`);
}

// ---------------------------------------------------------------------------
// Timesheets (every change to time carries a reason)
// ---------------------------------------------------------------------------

const reasonSchema = z.string().trim().min(1, "Give a reason for the change.").max(500);

/** A `datetime-local` value ("2026-10-05T16:00") on the store's wall clock. */
function wallClockField(fd: FormData, name: string, tz: string): Date | null | "invalid" {
  const raw = textField(fd, name);
  if (raw === "") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(raw);
  if (!match || !localDateSchema.safeParse(match[1]).success) return "invalid";
  return zonedInstant(match[1], match[2], tz);
}

export async function savePunch(_prev: StaffFormState, fd: FormData): Promise<StaffFormState> {
  const operator = await requireOperator();
  const reason = reasonSchema.safeParse(textField(fd, "reason"));
  if (!reason.success) return { error: firstIssue(reason.error) };
  const role = z.enum(JOB_ROLES).safeParse(textField(fd, "role"));
  if (!role.success) return { error: "Pick a role." };
  const { timezone } = await getStaffConfig();

  const clockInAt = wallClockField(fd, "clockIn", timezone);
  const clockOutAt = wallClockField(fd, "clockOut", timezone);
  if (clockInAt === null || clockInAt === "invalid" || clockOutAt === "invalid") return { error: "Check the clock-in and clock-out times." };
  const breaks = [];
  const count = Math.min(10, Number.parseInt(textField(fd, "breakCount"), 10) || 0);
  for (let i = 0; i < count; i++) {
    const startedAt = wallClockField(fd, `break-start-${i}`, timezone);
    const endedAt = wallClockField(fd, `break-end-${i}`, timezone);
    if (startedAt === null) continue;
    if (startedAt === "invalid" || endedAt === "invalid") return { error: "Check the break times." };
    breaks.push({ startedAt, endedAt, paid: checkbox(fd, `break-paid-${i}`) });
  }
  let declaredTipsCents: number;
  try {
    declaredTipsCents = dollarsToCents(fd, "tips");
  } catch {
    return { error: "Enter tips in dollars, like 12.50." };
  }

  const result = await saveManagerPunch(
    {
      entryId: textField(fd, "entryId") === "" ? null : idField(fd, "entryId"),
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
  const employeeId = textField(fd, "employeeId") === "" ? null : idField(fd, "employeeId");
  const approved = await approveWeek(week, employeeId, operator.id, cfg);
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
  if (end.data < start.data) return { error: "The last day can't be before the first." };
  await requestTimeOff({
    employeeId: idField(fd, "employeeId"),
    startDate: start.data,
    endDate: end.data,
    reason: textOrNull(fd, "reason"),
    decidedBy: operator.id,
  });
  revalidateStaff();
  return { notice: "Time off added." };
}
