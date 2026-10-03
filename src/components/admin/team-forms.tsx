"use client";

import { useActionState } from "react";
import {
  addEmployee,
  addOperator,
  changeEmployeePin,
  changeOwnPassword,
  type AuthFormState,
  type StaffFormState,
} from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { EMPLOYEE_ROLES, ROLE_LABEL } from "@/lib/orders";

const INITIAL: AuthFormState = {};

export function AddOperatorForm() {
  const [state, formAction, pending] = useActionState(addOperator, INITIAL);

  return (
    <form action={formAction}>
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="add-name">Name</FieldLabel>
            <Input
              id="add-name"
              name="name"
              type="text"
              autoComplete="off"
              required
              maxLength={120}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="add-email">Email</FieldLabel>
            <Input
              id="add-email"
              name="email"
              type="email"
              autoComplete="off"
              required
            />
          </Field>
        </div>
        <Field className="sm:max-w-xs">
          <FieldLabel htmlFor="add-password">Temporary password</FieldLabel>
          <Input
            id="add-password"
            name="password"
            type="text"
            autoComplete="off"
            required
            minLength={8}
          />
          <FieldDescription>
            At least 8 characters. Share it with them directly — they can change
            it below once they sign in.
          </FieldDescription>
        </Field>
        {state.error ? <FieldError>{state.error}</FieldError> : null}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Adding…" : "Add operator"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(
    changeOwnPassword,
    INITIAL,
  );

  return (
    <form action={formAction}>
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="pw-current">Current password</FieldLabel>
            <Input
              id="pw-current"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="pw-new">New password</FieldLabel>
            <Input
              id="pw-new"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
            />
            <FieldDescription>At least 8 characters.</FieldDescription>
          </Field>
        </div>
        {state.error ? <FieldError>{state.error}</FieldError> : null}
        <div>
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? "Updating…" : "Update password"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

/** Masked, digits-only PIN entry. A PIN is never shown back once saved. */
function PinInput({ id, placeholder }: { id: string; placeholder?: string }) {
  return (
    <Input
      id={id}
      placeholder={placeholder}
      name="pin"
      type="password"
      inputMode="numeric"
      pattern="\d{4}"
      maxLength={4}
      autoComplete="off"
      required
      className="tabular-nums tracking-widest"
    />
  );
}

const STAFF_INITIAL: StaffFormState = {};

export function AddEmployeeForm() {
  const [state, formAction, pending] = useActionState(addEmployee, STAFF_INITIAL);

  return (
    <form action={formAction}>
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem_8rem]">
          <Field>
            <FieldLabel htmlFor="emp-name">Name</FieldLabel>
            <Input
              key={state.name}
              id="emp-name"
              name="name"
              type="text"
              autoComplete="off"
              required
              maxLength={80}
              defaultValue={state.name}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="emp-role">Role</FieldLabel>
            <NativeSelect
              key={state.role}
              id="emp-role"
              name="role"
              defaultValue={state.role ?? "cashier"}
              className="w-full"
            >
              {EMPLOYEE_ROLES.map((role) => (
                <NativeSelectOption key={role} value={role}>
                  {ROLE_LABEL[role]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="emp-pin">PIN</FieldLabel>
            <PinInput id="emp-pin" />
          </Field>
        </div>
        <FieldDescription>
          Managers and owners approve voids, comps, refunds, big discounts and
          no-sale drawer opens. Tell them their PIN yourself: it isn&apos;t shown again.
        </FieldDescription>
        {state.error ? <FieldError>{state.error}</FieldError> : null}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Adding…" : "Add employee"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

export function ChangePinForm({ employeeId, name }: { employeeId: number; name: string }) {
  const [state, formAction, pending] = useActionState(changeEmployeePin, STAFF_INITIAL);
  const inputId = `pin-${employeeId}`;

  return (
    <form action={formAction} className="flex flex-wrap items-start gap-2">
      <input type="hidden" name="employeeId" value={employeeId} />
      <label htmlFor={inputId} className="sr-only">
        New PIN for {name}
      </label>
      <div className="w-24">
        <PinInput id={inputId} placeholder="New PIN" />
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Set PIN"}
      </Button>
      {state.error ? <FieldError className="basis-full">{state.error}</FieldError> : null}
    </form>
  );
}
