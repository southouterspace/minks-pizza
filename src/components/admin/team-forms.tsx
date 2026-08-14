"use client";

import { useActionState } from "react";
import {
  addOperator,
  changeOwnPassword,
  type AuthFormState,
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
