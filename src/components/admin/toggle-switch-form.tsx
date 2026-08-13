"use client";

import { useRef } from "react";
import { Switch } from "@/components/ui/switch";

/**
 * A storefront switch that submits a server action the moment it is toggled.
 *
 * The Base UI `Switch` renders a `<span role="switch">` plus a visually hidden
 * checkbox and swallows the native click, so it can never submit a form by
 * itself — we submit the surrounding form from `onCheckedChange` instead.
 * `label` becomes the switch's accessible name and flips with the state.
 */
export function ToggleSwitchForm({
  action,
  checked,
  label,
  className,
}: {
  action: () => Promise<void>;
  checked: boolean;
  label: string;
  className?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form action={action} ref={formRef} className={className}>
      <Switch
        checked={checked}
        aria-label={label}
        onCheckedChange={() => formRef.current?.requestSubmit()}
      />
    </form>
  );
}
