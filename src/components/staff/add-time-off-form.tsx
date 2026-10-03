"use client";

import { useActionState } from "react";
import { addTimeOff, type StaffFormState } from "@/app/admin/staff/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

const INITIAL: StaffFormState = {};

export function AddTimeOffForm({ employees, today }: { employees: { id: number; name: string }[]; today: string }) {
  const [state, formAction, pending] = useActionState(addTimeOff, INITIAL);
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-[1fr_auto_auto_1fr_auto] sm:items-end">
      <Field>
        <FieldLabel htmlFor="to-employee">Employee</FieldLabel>
        <NativeSelect id="to-employee" name="employeeId" required className="w-full">
          {employees.map((e) => (
            <NativeSelectOption key={e.id} value={e.id}>
              {e.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor="to-start">First day</FieldLabel>
        <Input id="to-start" name="startDate" type="date" required defaultValue={today} />
      </Field>
      <Field>
        <FieldLabel htmlFor="to-end">Last day</FieldLabel>
        <Input id="to-end" name="endDate" type="date" required defaultValue={today} />
      </Field>
      <Field>
        <FieldLabel htmlFor="to-reason">Reason</FieldLabel>
        <Input id="to-reason" name="reason" maxLength={500} />
      </Field>
      <Button type="submit" disabled={pending || employees.length === 0}>
        {pending ? "Adding…" : "Add time off"}
      </Button>
      {state.error ? <FieldError className="sm:col-span-5">{state.error}</FieldError> : null}
      {state.notice && !state.error ? (
        <p role="status" className="text-sm font-medium text-success sm:col-span-5">
          {state.notice}
        </p>
      ) : null}
    </form>
  );
}
