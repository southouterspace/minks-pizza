"use client";

import { useActionState, useState } from "react";
import { deleteShift, saveShift, type StaffFormState } from "@/app/admin/staff/actions";
import { JOB_ROLES, ROLE_LABEL, type JobRole } from "@/lib/timeclock";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export type ShiftDialogEmployee = { id: number; name: string; roles: JobRole[]; primary: JobRole | null };

export type ShiftDraft = {
  id: number | null;
  employeeId: number | null;
  role: JobRole | null;
  date: string;
  start: string;
  end: string;
  unpaidBreakMinutes: number;
  notes: string | null;
};

const INITIAL: StaffFormState = {};

/** Add or edit one shift. The trigger is whatever the grid cell renders. */
export function ShiftDialog({
  shift,
  employees,
  trigger,
  triggerClassName,
  triggerLabel,
  testId,
}: {
  shift: ShiftDraft;
  employees: ShiftDialogEmployee[];
  trigger: React.ReactNode;
  triggerClassName?: string;
  triggerLabel?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState<string>(shift.employeeId === null ? "" : String(shift.employeeId));
  const [state, formAction, pending] = useActionState(async (prev: StaffFormState, fd: FormData) => {
    const result = await saveShift(prev, fd);
    if (!result.error) setOpen(false);
    return result;
  }, INITIAL);

  const person = employees.find((e) => String(e.id) === employeeId);
  const roles = person ? person.roles : [...JOB_ROLES];
  const defaultRole =
    shift.role && roles.includes(shift.role) ? shift.role : (person?.primary ?? roles[0] ?? "cook");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className={triggerClassName} aria-label={triggerLabel} data-testid={testId}>
        {trigger}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{shift.id === null ? "Add shift" : "Edit shift"}</DialogTitle>
          <DialogDescription>
            {shift.id === null
              ? "New shifts are drafts until you publish the week."
              : "Changes to a published shift show to staff right away."}
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="grid gap-4" data-testid="shift-form">
          {shift.id !== null ? <input type="hidden" name="shiftId" value={shift.id} /> : null}
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="sh-employee">Employee</FieldLabel>
              <NativeSelect
                id="sh-employee"
                name="employeeId"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className="w-full"
              >
                <NativeSelectOption value="">Open shift</NativeSelectOption>
                {employees.map((e) => (
                  <NativeSelectOption key={e.id} value={e.id}>
                    {e.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="sh-role">Role</FieldLabel>
              <NativeSelect id="sh-role" name="role" key={employeeId} defaultValue={defaultRole} className="w-full">
                {roles.map((r) => (
                  <NativeSelectOption key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field>
              <FieldLabel htmlFor="sh-date">Date</FieldLabel>
              <Input id="sh-date" name="date" type="date" required defaultValue={shift.date} />
            </Field>
            <Field>
              <FieldLabel htmlFor="sh-start">Start</FieldLabel>
              <Input id="sh-start" name="start" type="time" required defaultValue={shift.start} />
            </Field>
            <Field>
              <FieldLabel htmlFor="sh-end">End</FieldLabel>
              <Input id="sh-end" name="end" type="time" required defaultValue={shift.end} />
            </Field>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">An end at or before the start runs past midnight.</p>
          <div className="grid grid-cols-3 gap-3">
            <Field>
              <FieldLabel htmlFor="sh-break">Unpaid break (min)</FieldLabel>
              <Input
                id="sh-break"
                name="unpaidBreakMinutes"
                type="number"
                min="0"
                max="240"
                step="5"
                defaultValue={shift.unpaidBreakMinutes}
              />
            </Field>
            <Field className="col-span-2">
              <FieldLabel htmlFor="sh-notes">Notes</FieldLabel>
              <Input id="sh-notes" name="notes" maxLength={500} defaultValue={shift.notes ?? ""} />
            </Field>
          </div>
          {state.error ? <FieldError>{state.error}</FieldError> : null}
          <DialogFooter className="sm:justify-between">
            {shift.id !== null ? (
              <Button type="submit" variant="destructive" formAction={deleteShift} formNoValidate>
                Delete
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={pending} data-testid="shift-save">
              {pending ? "Saving…" : "Save shift"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
