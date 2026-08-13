"use client";

import { useActionState } from "react";
import {
  loginOperator,
  setupOperator,
  type AuthFormState,
} from "@/app/admin/actions";
import { inputClass, labelClass, primaryButtonClass } from "./ui";

const INITIAL: AuthFormState = {};

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginOperator, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="login-email" className={labelClass}>
          Email
        </label>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="login-password" className={labelClass}>
          Password
        </label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-error">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className={`${primaryButtonClass} w-full`}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export function SetupForm() {
  const [state, formAction, pending] = useActionState(setupOperator, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="setup-name" className={labelClass}>
          Your name
        </label>
        <input
          id="setup-name"
          name="name"
          type="text"
          autoComplete="name"
          required
          maxLength={120}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="setup-email" className={labelClass}>
          Email
        </label>
        <input
          id="setup-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="setup-password" className={labelClass}>
          Password
        </label>
        <input
          id="setup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className={inputClass}
        />
        <p className="mt-1.5 text-xs text-faint">At least 8 characters.</p>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-error">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className={`${primaryButtonClass} w-full`}>
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
