import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The Nova button at counter size: 48px tall, readable at arm's length. */
export function Tap({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button className={cn("h-12 gap-2 rounded-xl px-4 text-base", className)} {...props} />;
}

/** A row of mutually exclusive choices with one selected. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  size = "md",
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" className={cn("flex gap-1 rounded-xl bg-muted p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 rounded-lg px-3 font-medium whitespace-nowrap transition-colors",
            size === "md" ? "h-11 text-base" : "h-9 text-sm",
            o.value === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
