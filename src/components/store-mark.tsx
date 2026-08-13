import { cn } from "@/lib/utils";

export type StoreMarkSource = {
  name: string;
  logoUrl: string | null;
  logoUploadedAt: Date | null;
};

/** Uploaded logo wins over an external URL; null means show the initial. */
export function resolveLogoSrc(store: {
  logoUrl: string | null;
  logoUploadedAt: Date | null;
}): string | null {
  if (store.logoUploadedAt) {
    return `/api/logo?v=${store.logoUploadedAt.getTime()}`;
  }
  return store.logoUrl;
}

/**
 * The store's visual mark: the logo when one is set, otherwise a circle with
 * the store's initial. Shared by the storefront header, the coming-soon page
 * and the admin sidebar so they can't drift apart.
 *
 * The logo is rendered at its natural shape — no rounding or cropping — so
 * crests and wordmarks aren't clipped into a circle.
 */
export function StoreMark({
  name,
  logoUrl,
  logoUploadedAt,
  className,
  textClassName,
}: StoreMarkSource & {
  /** Sizing box for the mark, e.g. "size-8" or "h-10 w-auto". */
  className?: string;
  /** Font sizing for the fallback initial. */
  textClassName?: string;
}) {
  const src = resolveLogoSrc({ logoUrl, logoUploadedAt });

  if (src) {
    return (
      // Operator-supplied image of unknown origin — a plain <img> avoids
      // next/image remote-pattern configuration.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        className={cn("shrink-0 object-contain", className)}
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
