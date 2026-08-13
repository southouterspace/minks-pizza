import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentOperator, operatorExists } from "@/lib/auth";
import { LoginForm } from "@/components/admin/auth-forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (!(await operatorExists())) redirect("/admin/setup");
  if (await getCurrentOperator()) redirect("/admin");

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1.5 text-sm text-muted">
          Sign in to manage orders, menu, and store settings.
        </p>
        <div className="mt-6 rounded-lg border border-border p-6">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
