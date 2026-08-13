import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, storeSettings } from "@/db";
import { getCurrentOperator } from "@/lib/auth";
import { AdminNavLinks } from "@/components/admin/nav-links";
import { logout } from "./actions";

export const metadata: Metadata = { title: "Admin" };

const signOutButtonClass =
  "rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors hover:bg-surface hover:text-foreground";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const operator = await getCurrentOperator();

  // Unauthenticated: render bare so /admin/login and /admin/setup work.
  if (!operator) return <>{children}</>;

  const [settings] = await db
    .select({ name: storeSettings.name })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1));
  const storeName = settings?.name ?? "Mink's Pizza";

  return (
    <div className="flex min-h-screen w-full flex-1">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-border md:flex">
        <div className="border-b border-border px-5 py-4">
          <Link href="/admin" className="block">
            <span className="block truncate text-sm font-semibold tracking-tight">
              {storeName}
            </span>
            <span className="block text-xs text-muted">Admin</span>
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <AdminNavLinks orientation="vertical" />
          <a
            href="/"
            target="_blank"
            rel="noreferrer"
            className="mt-4 block rounded-md px-3 py-2 text-sm text-muted transition-colors hover:bg-surface hover:text-foreground"
          >
            View store →
          </a>
        </div>
        <div className="border-t border-border p-4">
          <p className="truncate text-sm font-medium">{operator.name}</p>
          <form action={logout} className="mt-1 -ml-2">
            <button type="submit" className={signOutButtonClass}>
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur md:hidden">
          <div className="flex items-center justify-between px-4 pt-3">
            <Link href="/admin" className="text-sm font-semibold tracking-tight">
              {storeName}{" "}
              <span className="font-normal text-muted">Admin</span>
            </Link>
            <form action={logout}>
              <button type="submit" className={signOutButtonClass}>
                Sign out
              </button>
            </form>
          </div>
          <div className="flex items-center gap-1 overflow-x-auto px-2 py-2">
            <AdminNavLinks orientation="horizontal" />
            <a
              href="/"
              target="_blank"
              rel="noreferrer"
              className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface hover:text-foreground"
            >
              View store →
            </a>
          </div>
        </header>

        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
