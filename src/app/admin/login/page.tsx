import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentOperator, operatorExists } from "@/lib/auth";
import { LoginForm } from "@/components/admin/auth-forms";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (!(await operatorExists())) redirect("/admin/setup");
  if (await getCurrentOperator()) redirect("/admin");

  return (
    <div className="flex min-h-screen flex-1 items-center justify-center px-4 py-12">
      <Card className="w-full max-w-sm [--card-spacing:--spacing(6)]!">
        <CardHeader>
          <CardTitle className="text-xl! font-semibold! tracking-tight">
            Sign in
          </CardTitle>
          <CardDescription>
            Sign in to manage orders, menu, and store settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </div>
  );
}
