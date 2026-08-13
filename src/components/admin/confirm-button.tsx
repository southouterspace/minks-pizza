"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type ButtonSize = "xs" | "sm" | "default" | "lg";
type IdleVariant = "outline" | "ghost" | "secondary";

/**
 * Two-step destructive submit: first click arms the button, second click
 * submits the surrounding form. Disarms itself after a few seconds.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  size = "sm",
  variant = "outline",
  className,
}: {
  label: string;
  confirmLabel: string;
  size?: ButtonSize;
  variant?: IdleVariant;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  if (!armed) {
    return (
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={() => setArmed(true)}
      >
        {label}
      </Button>
    );
  }
  return (
    <Button type="submit" variant="destructive" size={size} className={className}>
      {confirmLabel}
    </Button>
  );
}
