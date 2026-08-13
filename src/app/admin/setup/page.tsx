import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { operatorExists } from "@/lib/auth";
import { SetupForm } from "@/components/admin/auth-forms";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Set up your store" };

export default async function SetupPage() {
  if (await operatorExists()) redirect("/admin/login");

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center px-4 py-12">
      <Card className="w-full max-w-sm [--card-spacing:--spacing(6)]!">
        <CardHeader>
          <CardTitle className="text-xl! font-semibold! tracking-tight">
            Welcome to your pizzeria
          </CardTitle>
          <CardDescription>
            Create the operator account you&apos;ll use to run the store. This
            only happens once.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SetupForm />
        </CardContent>
      </Card>
    </div>
  );
}
