import type { Metadata } from "next";
import Link from "next/link";
import { requireOperator } from "@/lib/auth";
import { EmployeeForm } from "@/components/staff/employee-form";

export const metadata: Metadata = { title: "Add employee" };

export default async function NewEmployeePage({ searchParams }: PageProps<"/admin/staff/employees/new">) {
  await requireOperator();
  // "Add another" links here with a new `after`, which remounts the form empty.
  const after = String((await searchParams).after ?? "");
  return (
    <div>
      <Link href="/admin/staff/employees" className="text-sm text-muted-foreground hover:text-foreground">
        ← Employees
      </Link>
      <h1 className="mt-2 mb-6 text-xl font-semibold tracking-tight">Add employee</h1>
      <EmployeeForm
        key={after}
        employee={{
          id: null,
          name: "",
          phone: null,
          email: null,
          hiredOn: null,
          notes: null,
          hasPin: false,
          roles: [],
          availability: null,
        }}
      />
    </div>
  );
}
