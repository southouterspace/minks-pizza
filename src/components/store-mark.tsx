import { cn } from "@/lib/utils";

/**
 * The store's visual mark: the uploaded logo when there is one, otherwise a
 * circle with the store's initial. Used in the storefront header, the
 * coming-soon page and the admin sidebar so they never drift apart.
 */
export function StoreMark({
  name,
  logoUrl,
  className,
  textClassName,
}: {
  name: string;
  logoUrl: string | null;
  /** Sizing for the mark itself, e.g. "size-8". */
  className?: string;
  /** Font sizing for the fallback initial. */
  textClassName?: string;
}) {
  if (logoUrl) {
    return (
      // The logo is an operator-supplied data: or remote URL, so a plain <img>
      // avoids next/image remote-pattern configuration.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={name}
        className={cn("shrink-0 rounded-full object-contain", className)}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-primary font-bold text-primary-foreground",
        className,
        textClassName,
      )}
    >
      {name.charAt(0)}
    </span>
  );
}
