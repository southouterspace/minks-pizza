import "server-only";
import { createHmac, randomInt } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, lt, notExists, notInArray } from "drizzle-orm";
import { db, employeeRoles, employees, shifts, timeEntries } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { nextId } from "@/db/ids";
import {
  availabilityFromStored,
  computeWeek,
  type EmployeeRole,
  type StoredAvailability,
  type WeeklyAvailability,
} from "@/lib/timeclock";
import { weekBounds } from "@/lib/zoned";
import { resolveWeek, type StaffConfig } from "@/lib/staff/config";
import { ROLE_COLUMNS, toPayEntry } from "@/lib/staff/queries";

export function pinDigest(pin: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return createHmac("sha256", secret).update(`pin:${pin}`).digest("hex");
}

/** A random 4-digit PIN nobody else has. */
export async function generatePin(): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pin = String(randomInt(0, 10_000)).padStart(4, "0");
    const [taken] = await db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.pinDigest, pinDigest(pin)));
    if (!taken) return pin;
  }
  throw new Error("Couldn't find a free PIN");
}

export type EmployeeInput = {
  name: string;
  phone: string | null;
  email: string | null;
  hiredOn: string | null;
  notes: string | null;
  availability: StoredAvailability | null;
  roles: [EmployeeRole, ...EmployeeRole[]];
  /** Undefined leaves the PIN alone. */
  pin: string | undefined;
};

/** Creates (null id) or updates an employee with their roles, in one transaction. */
export async function saveEmployee(id: number | null, input: EmployeeInput): Promise<{ id: number } | { error: string }> {
  const { roles, pin, ...details } = input;
  const values = { ...details, ...(pin === undefined ? {} : { pinDigest: pinDigest(pin) }), updatedAt: new Date() };
  try {
    if (id === null) {
      const created = await nextId("employees");
      await db.batch([
        db.insert(employees).overridingSystemValue().values({ ...values, id: created }),
        db.insert(employeeRoles).values(roles.map((r) => ({ ...r, employeeId: created }))),
      ]);
      return { id: created };
    }
    await db.batch([
      db.update(employees).set(values).where(eq(employees.id, id)),
      db.delete(employeeRoles).where(and(eq(employeeRoles.employeeId, id), notInArray(employeeRoles.role, roles.map((r) => r.role)))),
      ...roles.map((r) =>
        db
          .insert(employeeRoles)
          .values({ ...r, employeeId: id })
          .onConflictDoUpdate({
            target: [employeeRoles.employeeId, employeeRoles.role],
            set: { hourlyRateCents: r.hourlyRateCents, isPrimary: r.isPrimary },
          }),
      ),
    ]);
    return { id };
  } catch (error) {
    // pin_digest is the only unique column a save can collide on.
    if (isUniqueViolation(error)) return { error: "Someone else already has that PIN. Pick another." };
    throw error;
  }
}

/**
 * Archiving takes someone off the clock and the schedule but keeps every
 * punch for payroll. Their upcoming shifts become open shifts to fill.
 * Both writes carry the "not on the clock" guard, so a clock-in racing the
 * archive leaves them active and on their shifts.
 */
export async function setEmployeeActive(id: number, active: boolean): Promise<"archived" | "restored" | "on-clock"> {
  const now = new Date();
  if (active) {
    await db.update(employees).set({ isActive: true, updatedAt: now }).where(eq(employees.id, id));
    return "restored";
  }
  const offTheClock = notExists(
    db
      .select({ id: timeEntries.id })
      .from(timeEntries)
      .where(and(eq(timeEntries.employeeId, id), isNull(timeEntries.clockOutAt))),
  );
  const [archived] = await db.batch([
    db
      .update(employees)
      .set({ isActive: false, updatedAt: now })
      .where(and(eq(employees.id, id), offTheClock))
      .returning({ id: employees.id }),
    db
      .update(shifts)
      .set({ employeeId: null, updatedAt: now })
      .where(and(eq(shifts.employeeId, id), gte(shifts.startsAt, now), offTheClock)),
  ]);
  return archived.length > 0 ? "archived" : "on-clock";
}

export async function removeEmployeePin(id: number): Promise<void> {
  await db.update(employees).set({ pinDigest: null, updatedAt: new Date() }).where(eq(employees.id, id));
}

export type EmployeeListRow = {
  id: number;
  name: string;
  isActive: boolean;
  hasPin: boolean;
  /** Primary role first. */
  roles: EmployeeRole[];
  /** Paid minutes this payroll week so far. */
  weekMinutes: number;
};

/** Active employees first, then by name. */
export async function listEmployees(cfg: StaffConfig, now = new Date()): Promise<EmployeeListRow[]> {
  const { from, to } = weekBounds(resolveWeek(undefined, cfg, now), cfg.timezone);
  const [rows, entries] = await Promise.all([
    db.query.employees.findMany({
      columns: { id: true, name: true, isActive: true, pinDigest: true },
      with: { roles: { columns: ROLE_COLUMNS } },
      orderBy: [desc(employees.isActive), asc(employees.name)],
    }),
    db.query.timeEntries.findMany({
      where: and(gte(timeEntries.clockInAt, from), lt(timeEntries.clockInAt, to)),
      with: { breaks: true },
    }),
  ]);
  const entriesOf = Map.groupBy(entries, (e) => e.employeeId);
  return rows.map((e) => ({
    id: e.id,
    name: e.name,
    isActive: e.isActive,
    hasPin: e.pinDigest !== null,
    roles: e.roles.toSorted((a, b) => Number(b.isPrimary) - Number(a.isPrimary)),
    weekMinutes: computeWeek((entriesOf.get(e.id) ?? []).map(toPayEntry), cfg.rules, cfg.timezone, now).totals.paidMinutes,
  }));
}

export type EmployeeDetail = {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  hiredOn: string | null;
  notes: string | null;
  isActive: boolean;
  hasPin: boolean;
  roles: EmployeeRole[];
  availability: WeeklyAvailability;
};

export async function getEmployee(id: number): Promise<EmployeeDetail | null> {
  const e = await db.query.employees.findFirst({ where: eq(employees.id, id), with: { roles: { columns: ROLE_COLUMNS } } });
  if (!e) return null;
  return {
    id: e.id,
    name: e.name,
    phone: e.phone,
    email: e.email,
    hiredOn: e.hiredOn,
    notes: e.notes,
    isActive: e.isActive,
    hasPin: e.pinDigest !== null,
    roles: e.roles,
    availability: availabilityFromStored(e.availability),
  };
}
