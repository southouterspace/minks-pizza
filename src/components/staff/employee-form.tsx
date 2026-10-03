"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { saveEmployee, type StaffFormState } from "@/app/admin/staff/actions";
import { JOB_ROLES, PIN_LENGTH, PIN_PATTERN, ROLE_LABEL, type JobRole, type WeeklyAvailability } from "@/lib/timeclock";
import { centsToDollars } from "@/lib/money";
import { DAY_NAMES, WEEKDAYS, type Weekday } from "@/lib/zoned";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

export type EmployeeFormValues = {
  id: number | null;
  name: string;
  phone: string | null;
  email: string | null;
  hiredOn: string | null;
  notes: string | null;
  hasPin: boolean;
  roles: { role: JobRole; hourlyRateCents: number; isPrimary: boolean }[];
  availability: WeeklyAvailability;
};

const INITIAL: StaffFormState = {};
const legend = "w-full border-b border-border pb-2 text-sm!";

export function EmployeeForm({ employee }: { employee: EmployeeFormValues }) {
  const [state, formAction, pending] = useActionState(saveEmployee, INITIAL);
  const [roles, setRoles] = useState<Set<JobRole>>(() => new Set(employee.roles.map((r) => r.role)));
  const [kinds, setKinds] = useState<string[]>(() => WEEKDAYS.map((d) => employee.availability[d].kind));
  const isNew = employee.id === null;

  if (isNew && state.savedId) {
    return (
      <div className="max-w-xl rounded-xl border border-border p-5" role="status" data-testid="employee-created">
        <p className="font-medium">{state.notice}</p>
        {state.pin ? <PinNotice pin={state.pin} /> : <p className="mt-2 text-sm text-muted-foreground">No PIN yet, so they can&apos;t use the time clock.</p>}
        <div className="mt-4 flex gap-2">
          <Link href={`/admin/staff/employees/${state.savedId}`} className={buttonVariants()}>
            Open profile
          </Link>
          <Link href={`/admin/staff/employees/new?after=${state.savedId}`} className={buttonVariants({ variant: "outline" })}>
            Add another
          </Link>
        </div>
      </div>
    );
  }

  const rateOf = (role: JobRole) => employee.roles.find((r) => r.role === role)?.hourlyRateCents;
  const primary = employee.roles.find((r) => r.isPrimary)?.role ?? employee.roles[0]?.role;

  return (
    <form action={formAction} className="max-w-2xl space-y-8">
      {employee.id !== null ? <input type="hidden" name="employeeId" value={employee.id} /> : null}

      <FieldSet>
        <FieldLegend className={legend}>Details</FieldLegend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="e-name">Name</FieldLabel>
            <Input id="e-name" name="name" required maxLength={120} defaultValue={employee.name} autoComplete="off" />
          </Field>
          <Field>
            <FieldLabel htmlFor="e-hired">Hired on</FieldLabel>
            <Input id="e-hired" name="hiredOn" type="date" defaultValue={employee.hiredOn ?? ""} />
          </Field>
          <Field>
            <FieldLabel htmlFor="e-phone">Phone</FieldLabel>
            <Input id="e-phone" name="phone" type="tel" maxLength={25} defaultValue={employee.phone ?? ""} />
          </Field>
          <Field>
            <FieldLabel htmlFor="e-email">Email</FieldLabel>
            <Input id="e-email" name="email" type="email" maxLength={200} defaultValue={employee.email ?? ""} />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="e-notes">Notes</FieldLabel>
          <Textarea id="e-notes" name="notes" maxLength={1000} defaultValue={employee.notes ?? ""} rows={2} />
        </Field>
      </FieldSet>

      <FieldSet>
        <FieldLegend className={legend}>Roles and pay</FieldLegend>
        <FieldDescription>
          Each role has its own hourly rate. The primary role is the clock&apos;s default when no shift is scheduled.
        </FieldDescription>
        <div className="divide-y divide-border rounded-lg border border-border">
          {JOB_ROLES.map((role) => {
            const on = roles.has(role);
            const rate = rateOf(role);
            return (
              <div key={role} className="flex flex-wrap items-center gap-3 px-3 py-2" data-testid={`role-row-${role}`}>
                <Field orientation="horizontal" className="w-36">
                  <Checkbox
                    id={`role-${role}`}
                    name={`role-${role}`}
                    checked={on}
                    onCheckedChange={(checked) =>
                      setRoles((s) => {
                        const next = new Set(s);
                        if (checked) next.add(role);
                        else next.delete(role);
                        return next;
                      })
                    }
                  />
                  <FieldLabel htmlFor={`role-${role}`}>{ROLE_LABEL[role]}</FieldLabel>
                </Field>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    name={`rate-${role}`}
                    aria-label={`${ROLE_LABEL[role]} hourly rate`}
                    type="number"
                    min="0"
                    step="0.01"
                    disabled={!on}
                    required={on}
                    defaultValue={rate === undefined ? "" : centsToDollars(rate)}
                    className="w-24 tabular-nums"
                  />
                  <span className="text-sm text-muted-foreground">/ h</span>
                </div>
                <label className="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground">
                  <input type="radio" name="primaryRole" value={role} disabled={!on} defaultChecked={primary === role} />
                  Primary
                </label>
              </div>
            );
          })}
        </div>
      </FieldSet>

      <FieldSet>
        <FieldLegend className={legend}>Weekly availability</FieldLegend>
        <FieldDescription>The schedule warns when a shift falls outside these times.</FieldDescription>
        <div className="space-y-2">
          {WEEKDAYS.map((d) => {
            const day = DAY_NAMES[d];
            const window = windowOf(employee.availability, d);
            return (
            <div key={day} className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2">
              <span className="w-24 text-sm font-medium">{day}</span>
              <NativeSelect
                name={`avail-${d}`}
                aria-label={`${day} availability`}
                value={kinds[d]}
                onChange={(e) => {
                  const value = e.target.value;
                  setKinds((k) => k.map((v, i) => (i === d ? value : v)));
                }}
                size="sm"
              >
                <NativeSelectOption value="any">Any time</NativeSelectOption>
                <NativeSelectOption value="window">Between…</NativeSelectOption>
                <NativeSelectOption value="none">Unavailable</NativeSelectOption>
              </NativeSelect>
              {kinds[d] === "window" ? (
                <span className="flex items-center gap-2">
                  <Input
                    name={`from-${d}`}
                    type="time"
                    aria-label={`${day} from`}
                    required
                    defaultValue={window?.from ?? "10:00"}
                    className="w-auto"
                  />
                  <span className="text-sm text-muted-foreground">to</span>
                  <Input
                    name={`to-${d}`}
                    type="time"
                    aria-label={`${day} to`}
                    required
                    defaultValue={window?.to ?? "22:00"}
                    className="w-auto"
                  />
                </span>
              ) : null}
            </div>
            );
          })}
        </div>
      </FieldSet>

      <FieldSet>
        <FieldLegend className={legend}>Time clock PIN</FieldLegend>
        <FieldGroup>
          <Field className="sm:max-w-xs">
            <FieldLabel htmlFor="e-pin">{employee.hasPin ? "New PIN" : "PIN"}</FieldLabel>
            <Input
              id="e-pin"
              name="pin"
              inputMode="numeric"
              pattern={PIN_PATTERN}
              maxLength={PIN_LENGTH.max}
              autoComplete="off"
              placeholder={employee.hasPin ? "Leave blank to keep" : "4 to 6 digits"}
              className="tabular-nums"
            />
            <FieldDescription>
              {employee.hasPin ? "A PIN is set. Enter a new one to replace it." : "Without a PIN they can't use the clock."}{" "}
              PINs are stored hashed, so they are shown only once.
            </FieldDescription>
          </Field>
        </FieldGroup>
        {state.pin && !isNew ? <PinNotice pin={state.pin} /> : null}
      </FieldSet>

      {state.error ? <FieldError>{state.error}</FieldError> : null}
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
        <Button type="submit" disabled={pending} data-testid="employee-save">
          {pending ? "Saving…" : isNew ? "Add employee" : "Save"}
        </Button>
        <Button type="submit" name="pinAction" value="generate" variant="outline" disabled={pending}>
          {isNew ? "Add with a generated PIN" : "Save with a new generated PIN"}
        </Button>
        {state.notice && !state.error ? (
          <span className="text-sm font-medium text-success" role="status">
            {state.notice}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function windowOf(availability: WeeklyAvailability, day: Weekday) {
  const a = availability[day];
  return a.kind === "window" ? a : null;
}

function PinNotice({ pin }: { pin: string }) {
  return (
    <p className="mt-3 rounded-lg bg-muted px-4 py-3 text-sm" data-testid="pin-notice">
      Their PIN is <span className="font-mono text-lg font-semibold tracking-widest">{pin}</span>. Write it down now: it
      won&apos;t be shown again.
    </p>
  );
}
