import Link from "next/link";
import { CartProvider } from "@/components/cart-context";
import { StoreMark } from "@/components/store-mark";
import { CartBadge } from "@/components/store/cart-badge";
import { Separator } from "@/components/ui/separator";
import { getSettings } from "@/lib/settings-server";

export default async function StoreLayout({ children }: LayoutProps<"/">) {
  const settings = await getSettings();

  return (
    <CartProvider>
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <StoreMark
              name={settings.name}
              logoUrl={settings.logoUrl}
              logoUploadedAt={settings.logoUploadedAt}
              className="max-h-10 w-auto max-w-40"
              textClassName="text-sm size-8"
            />
            <span className="text-[15px] font-semibold tracking-tight">
              {settings.name}
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            <Link
              href="/"
              className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Menu
            </Link>
            <CartBadge />
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            © {new Date().getFullYear()} {settings.name}
          </p>
          <div className="flex items-center gap-4">
            {settings.phone ? <span>{settings.phone}</span> : null}
            {settings.phone && settings.addressLine1 ? (
              <Separator orientation="vertical" className="h-4" />
            ) : null}
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
