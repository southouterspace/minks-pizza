import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOperator } from "@/lib/auth";
import { formatHours, ROLE_LABEL } from "@/lib/timeclock";
import { centsToDollars } from "@/lib/money";
import { getStaffConfig } from "@/lib/staff/config";
import { listEmployees } from "@/lib/staff/employees";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Employees" };

export default async function EmployeesPage() {
  await requireOperator();
  const rows = await listEmployees(await getStaffConfig());

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Employees</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Staff clock in at the time clock with a PIN. They never get an admin login.
          </p>
        </div>
        <Link href="/admin/staff/employees/new" className={buttonVariants()}>
          <Plus /> Add employee
        </Link>
      </div>

      {rows.length === 0 ? (
        <Empty className="mt-6 border border-dashed">
          <EmptyHeader>
            <EmptyTitle>No employees yet</EmptyTitle>
            <EmptyDescription>Add your staff, their roles and pay rates, and give each a PIN for the clock.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="mt-6 gap-0! py-0!">
          {rows.map((row, i) => (
            <Link
              key={row.id}
              href={`/admin/staff/employees/${row.id}`}
              data-testid="employee-row"
              className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 hover:bg-muted/50 ${i > 0 ? "border-t border-border" : ""}`}
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <span className="truncate">{row.name}</span>
                  {row.isActive ? null : <Badge variant="secondary">Archived</Badge>}
                </p>
                <p className="mt-0.5 flex flex-wrap gap-1">
                  {row.roles.map((r) => (
                    <Badge key={r.role} variant="outline">
                      {ROLE_LABEL[r.role]} · ${centsToDollars(r.hourlyRateCents)}
                    </Badge>
                  ))}
                </p>
              </div>
              <span className={`text-xs ${row.hasPin ? "text-muted-foreground" : "font-medium text-warning"}`}>
                {row.hasPin ? "PIN set" : "No PIN"}
              </span>
              <span className="w-20 text-right text-sm tabular-nums">{formatHours(row.weekMinutes)}</span>
            </Link>
          ))}
        </Card>
      )}
      <p className="mt-2 text-right text-xs text-muted-foreground">Hours are this payroll week so far.</p>
    </div>
  );
}
