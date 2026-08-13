import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { operatorExists } from "@/lib/auth";
import { SetupForm } from "@/components/admin/auth-forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Set up your store" };

export default async function SetupPage() {
  if (await operatorExists()) redirect("/admin/login");

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold tracking-tight">
          Welcome to your pizzeria
        </h1>
        <p className="mt-1.5 text-sm text-muted">
          Create the operator account you&apos;ll use to run the store. This
          only happens once.
        </p>
        <div className="mt-6 rounded-lg border border-border p-6">
          <SetupForm />
        </div>
      </div>
    </div>
  );
}
