"use client";

import { useActionState, useState } from "react";
import type { StaffFormState } from "@/app/admin/staff/actions";
import { ROLE_LABEL, type JobRole, type StaffOption } from "@/lib/timeclock";
import { Field, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

const INITIAL: StaffFormState = {};

/** A dialog's open state wired to its form action: a save without an error closes it. */
export function useDialogAction(action: (prev: StaffFormState, fd: FormData) => Promise<StaffFormState>) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(async (prev: StaffFormState, fd: FormData) => {
    const result = await action(prev, fd);
    if (!result.error) setOpen(false);
    return result;
  }, INITIAL);
  return { open, setOpen, state, formAction, pending };
}

/**
 * The employee picker and the role picker that follows it. The role select
 * remounts when the employee changes, so its default resets to theirs.
 */
export function EmployeeRoleFields({
  idPrefix,
  employees,
  employeeId,
  onEmployeeChange,
  employeeLocked = false,
  openShiftOption = false,
  roles,
  defaultRole,
}: {
  idPrefix: string;
  employees: StaffOption[];
  employeeId: string;
  onEmployeeChange: (id: string) => void;
  /** Editing a punch keeps its employee: a hidden input instead of a select. */
  employeeLocked?: boolean;
  openShiftOption?: boolean;
  roles: JobRole[];
  defaultRole: JobRole | undefined;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {employeeLocked ? (
        <input type="hidden" name="employeeId" value={employeeId} />
      ) : (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-employee`}>Employee</FieldLabel>
          <NativeSelect
            id={`${idPrefix}-employee`}
            name="employeeId"
            value={employeeId}
            onChange={(e) => onEmployeeChange(e.target.value)}
            className="w-full"
          >
            {openShiftOption ? <NativeSelectOption value="">Open shift</NativeSelectOption> : null}
            {employees.map((e) => (
              <NativeSelectOption key={e.id} value={e.id}>
                {e.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-role`}>Role</FieldLabel>
        <NativeSelect id={`${idPrefix}-role`} name="role" key={employeeId} defaultValue={defaultRole} className="w-full">
          {roles.map((r) => (
            <NativeSelectOption key={r} value={r}>
              {ROLE_LABEL[r]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
    </div>
  );
}
