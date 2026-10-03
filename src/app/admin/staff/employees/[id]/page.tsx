import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOperator } from "@/lib/auth";
import { removeEmployeePin, setEmployeeActive } from "@/app/admin/staff/actions";
import { ConfirmButton } from "@/components/admin/confirm-button";
import { getEmployee } from "@/lib/staff/employees";
import { EmployeeForm } from "@/components/staff/employee-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Employee" };

const NOTICES: Record<string, { text: string; tone: "success" | "warning" }> = {
  archived: { text: "Archived. Their upcoming shifts are now open shifts.", tone: "success" },
  restored: { text: "Restored. They can use the time clock again.", tone: "success" },
  "pin-removed": { text: "PIN removed. They can't use the time clock until they get a new one.", tone: "success" },
  "on-clock": { text: "They're on the clock. Clock them out before archiving.", tone: "warning" },
};

export default async function EmployeePage({ params, searchParams }: PageProps<"/admin/staff/employees/[id]">) {
  await requireOperator();
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const notice = NOTICES[String((await searchParams).notice ?? "")];
  const employee = await getEmployee(id);
  if (!employee) notFound();

  return (
    <div>
      <Link href="/admin/staff/employees" className="text-sm text-muted-foreground hover:text-foreground">
        ← Employees
      </Link>
      <div className="mt-2 mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{employee.name}</h1>
        {employee.isActive ? null : <Badge variant="secondary">Archived</Badge>}
        <Link href={`/admin/staff/timesheets`} className="ml-auto text-sm text-muted-foreground hover:text-foreground">
          Timesheets →
        </Link>
      </div>
      {notice ? (
        <p role="status" className={`mb-6 text-sm font-medium ${notice.tone === "success" ? "text-success" : "text-warning"}`}>
          {notice.text}
        </p>
      ) : null}

      <EmployeeForm employee={employee} />

      <div className="mt-10 max-w-2xl space-y-4 border-t border-border pt-6">
        {employee.hasPin ? (
          <form action={removeEmployeePin} className="flex flex-wrap items-center justify-between gap-3">
            <input type="hidden" name="employeeId" value={employee.id} />
            <p className="text-sm text-muted-foreground">Remove their PIN to stop them using the clock.</p>
            <ConfirmButton label="Remove PIN" confirmLabel="Confirm remove" />
          </form>
        ) : null}
        <form action={setEmployeeActive} className="flex flex-wrap items-center justify-between gap-3">
          <input type="hidden" name="employeeId" value={employee.id} />
          <input type="hidden" name="active" value={String(!employee.isActive)} />
          <p className="text-sm text-muted-foreground">
            {employee.isActive
              ? "Archive when someone leaves. Their hours stay in payroll history; they drop off the schedule and the clock."
              : "Restore to put them back on the schedule and the clock."}
          </p>
          {employee.isActive ? (
            <ConfirmButton label="Archive" confirmLabel="Confirm archive" />
          ) : (
            <Button type="submit" variant="outline" size="sm">
              Restore
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}
