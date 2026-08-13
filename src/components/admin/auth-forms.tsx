"use client";

import { useActionState } from "react";
import {
  loginOperator,
  setupOperator,
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

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginOperator, INITIAL);

  return (
    <form action={formAction}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="login-email">Email</FieldLabel>
          <Input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="login-password">Password</FieldLabel>
          <Input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        {state.error ? <FieldError>{state.error}</FieldError> : null}
        <Button type="submit" size="lg" disabled={pending} className="w-full">
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </FieldGroup>
    </form>
  );
}

export function SetupForm() {
  const [state, formAction, pending] = useActionState(setupOperator, INITIAL);

  return (
    <form action={formAction}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="setup-name">Your name</FieldLabel>
          <Input
            id="setup-name"
            name="name"
            type="text"
            autoComplete="name"
            required
            maxLength={120}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="setup-email">Email</FieldLabel>
          <Input
            id="setup-email"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="setup-password">Password</FieldLabel>
          <Input
            id="setup-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
          />
          <FieldDescription>At least 8 characters.</FieldDescription>
        </Field>
        {state.error ? <FieldError>{state.error}</FieldError> : null}
        <Button type="submit" size="lg" disabled={pending} className="w-full">
          {pending ? "Creating account…" : "Create account"}
        </Button>
      </FieldGroup>
    </form>
  );
}
