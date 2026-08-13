import Link from "next/link";
import { CartProvider } from "@/components/cart-context";
import { CartBadge } from "@/components/store/cart-badge";
import { getSettings } from "@/lib/orders";

export default async function StoreLayout({ children }: LayoutProps<"/">) {
  const settings = await getSettings();

  return (
    <CartProvider>
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-bold text-accent-foreground">
              {settings.name.charAt(0)}
            </span>
            <span className="text-[15px] font-semibold tracking-tight">
              {settings.name}
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            <Link
              href="/"
              className="rounded-md px-3 py-2 text-sm text-muted transition-colors hover:text-foreground"
            >
              Menu
            </Link>
            <CartBadge />
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            © {new Date().getFullYear()} {settings.name}
          </p>
          <div className="flex items-center gap-4">
            {settings.phone ? <span>{settings.phone}</span> : null}
            {settings.addressLine1 ? (
              <span>
                {settings.addressLine1}, {settings.city}
              </span>
            ) : null}
          </div>
        </div>
      </footer>
    </CartProvider>
  );
}
