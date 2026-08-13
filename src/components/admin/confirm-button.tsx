"use client";

import { useEffect, useState } from "react";

/**
 * Two-step destructive submit: first click arms the button, second click
 * submits the surrounding form. Disarms itself after a few seconds.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  className = "",
  confirmClassName,
}: {
  label: string;
  confirmLabel: string;
  className?: string;
  confirmClassName?: string;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  if (!armed) {
    return (
      <button type="button" onClick={() => setArmed(true)} className={className}>
        {label}
      </button>
    );
  }
  return (
    <button type="submit" className={confirmClassName ?? className}>
      {confirmLabel}
    </button>
  );
}
