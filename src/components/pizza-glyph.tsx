import type { Placement } from "@/lib/toppings";
import { cn } from "@/lib/utils";

const FILL: Record<Placement, string> = {
  whole: "M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1Z",
  left: "M8 1a7 7 0 0 0 0 14Z",
  right: "M8 1a7 7 0 0 1 0 14Z",
};

export function PizzaGlyph({ placement, className }: { placement: Placement; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cn("size-4 shrink-0", className)}>
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d={FILL[placement]} fill="currentColor" />
    </svg>
  );
}
