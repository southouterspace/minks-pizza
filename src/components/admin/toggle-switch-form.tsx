"use client";

import { useTransition } from "react";
import { Switch } from "@/components/ui/switch";

/**
 * A storefront switch that runs a server action the moment it is toggled.
 *
 * It calls the action directly rather than submitting a `<form>`: React resets
 * a form after its action completes, which snaps the Base UI switch's hidden
 * checkbox back to its first-render state, and the next click then toggles
 * the DOM without React seeing a change. `label` becomes the switch's
 * accessible name and flips with the state.
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
  const [pending, startTransition] = useTransition();

  return (
    <div className={className}>
      <Switch
        checked={checked}
        aria-label={label}
        disabled={pending}
        onCheckedChange={() => startTransition(() => action())}
      />
    </div>
  );
}
