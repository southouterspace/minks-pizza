"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, gte, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db, employeeRoles, employees, shifts, timeEntries } from "@/db";
import { requireOperator } from "@/lib/auth";
import { checkbox, dollarsToCents, idField, textField } from "@/lib/form-data";
import { JOB_ROLES, ROLE_LABEL, type JobRole, type WeeklyAvailability, type Weekday } from "@/lib/timeclock";
import {
  copyPreviousWeek,
  generatePin,
  getStaffConfig,
  isUniqueViolation,
  pinDigest,
  publishWeek,
  resolveWeek,
} from "@/lib/timeclock-server";
import { hhmmSchema, localDateSchema, shiftInstants } from "@/lib/zoned";

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

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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

function availabilityFrom(fd: FormData): WeeklyAvailability | null | string {
  const days: WeeklyAvailability = [];
  for (let d = 0; d < 7; d++) {
    const day = d as Weekday;
    const kind = textField(fd, `avail-${d}`);
    if (kind === "none") days.push({ day, kind: "none" });
    else if (kind === "window") {
      const from = hhmmSchema.safeParse(textField(fd, `from-${d}`));
      const to = hhmmSchema.safeParse(textField(fd, `to-${d}`));
      if (!from.success || !to.success) return `Set both times for ${DAY_NAMES[d]}.`;
      days.push({ day, kind: "window", from: from.data, to: to.data });
    } else days.push({ day, kind: "any" });
  }
  return days.every((d) => d.kind === "any") ? null : days;
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
