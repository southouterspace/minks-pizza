import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { ChefHat, ExternalLink } from "lucide-react";
import { db, storeSettings } from "@/db";
import { getCurrentOperator } from "@/lib/auth";
import { AdminNavLinks } from "@/components/admin/nav-links";
import { StoreMark } from "@/components/store-mark";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { logout } from "./actions";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const operator = await getCurrentOperator();

  // Unauthenticated: render bare so /admin/login and /admin/setup work.
  if (!operator) return <>{children}</>;

  const [settings] = await db
    .select({
      name: storeSettings.name,
      logoUrl: storeSettings.logoUrl,
      logoUploadedAt: storeSettings.logoUploadedAt,
    })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  const storeName = settings?.name ?? "Mink's Pizza";

  return (
    <div className="flex min-h-screen w-full flex-1">
      {/* Desktop sidebar */}
      <aside className="print:hidden sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-border md:flex">
        <div className="border-b border-border px-5 py-4">
          <Link href="/admin" className="flex items-center gap-2.5">
            <StoreMark
              name={storeName}
              logoUrl={settings?.logoUrl ?? null}
              logoUploadedAt={settings?.logoUploadedAt ?? null}
              className="max-h-8 w-auto max-w-28"
              textClassName="size-8 text-sm"
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold tracking-tight">
                {storeName}
              </span>
              <span className="block text-xs text-muted-foreground">Admin</span>
            </span>
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <AdminNavLinks orientation="vertical" />
          <Separator className="my-3" />
          <Link
            href="/kitchen"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChefHat className="size-4 shrink-0" aria-hidden="true" />
            Kitchen display
          </Link>
          <a
            href="/"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
            View store
          </a>
        </div>
        <div className="border-t border-border p-4">
          <p className="truncate text-sm font-medium">{operator.name}</p>
          <form action={logout} className="mt-1 -ml-2.5">
            <Button
              type="submit"
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
            >
              Sign out
            </Button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="print:hidden sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur md:hidden">
          <div className="flex items-center justify-between px-4 pt-3">
            <Link href="/admin" className="text-sm font-semibold tracking-tight">
              {storeName}{" "}
              <span className="font-normal text-muted-foreground">Admin</span>
            </Link>
            <form action={logout}>
              <Button
                type="submit"
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
              >
                Sign out
              </Button>
            </form>
          </div>
          <div className="flex items-center gap-1 overflow-x-auto px-2 py-2">
            <AdminNavLinks orientation="horizontal" />
            <Link
              href="/kitchen"
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChefHat className="size-4 shrink-0" aria-hidden="true" />
              Kitchen
            </Link>
            <a
              href="/"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
              View store
            </a>
          </div>
        </header>

        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6 lg:py-8 has-[[data-wide]]:max-w-6xl print:max-w-none print:p-0">
          {children}
        </main>
      </div>
    </div>
  );
}
