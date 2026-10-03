import type { Metadata } from "next";
import { asc, desc } from "drizzle-orm";
import { db, employees, operators } from "@/db";
import { requireOperator } from "@/lib/auth";
import { deactivateEmployee, removeOperator } from "@/app/admin/actions";
import { ConfirmButton } from "@/components/admin/confirm-button";
import {
  AddEmployeeForm,
  AddOperatorForm,
  ChangePasswordForm,
  ChangePinForm,
} from "@/components/admin/team-forms";
import { ROLE_LABEL } from "@/lib/orders";
import { getStoreBasics } from "@/lib/settings-server";
import { formatStoreDateTime } from "@/lib/store-time";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Team" };

const NOTICES: Record<string, { text: string; tone: "success" | "warning" }> = {
  added: { text: "Account created.", tone: "success" },
  removed: { text: "Account removed.", tone: "success" },
  password: { text: "Your password was updated.", tone: "success" },
  "self-remove": {
    text: "You can't remove your own account.",
    tone: "warning",
  },
  "staff-added": { text: "Employee added. Their PIN works at the POS now.", tone: "success" },
  "pin-changed": { text: "PIN changed.", tone: "success" },
  "staff-deactivated": { text: "Employee deactivated. Their PIN no longer works.", tone: "success" },
  "last-approver": {
    text: "Keep at least one active manager or owner: they approve voids and close shifts.",
    tone: "warning",
  },
};


const rowClass = (i: number) =>
  i === 0
    ? "flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4"
    : "flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-5 py-4";

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const current = await requireOperator();
  const notice = NOTICES[String((await searchParams).notice ?? "")];

  const [{ timezone: tz }, rows, staff] = await Promise.all([
    getStoreBasics(),
    db
      .select({
        id: operators.id,
        name: operators.name,
        email: operators.email,
        createdAt: operators.createdAt,
      })
      .from(operators)
      .orderBy(asc(operators.id)),
    db
      .select({ id: employees.id, name: employees.name, role: employees.role, isActive: employees.isActive })
      .from(employees)
      .orderBy(desc(employees.isActive), asc(employees.name)),
  ]);
  const active = staff.filter((e) => e.isActive);
  const inactive = staff.filter((e) => !e.isActive);

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Team</h1>

      {notice ? (
        <p
          role="status"
          className={
            notice.tone === "success"
              ? "mt-4 text-sm font-medium text-success"
              : "mt-4 text-sm font-medium text-warning"
          }
        >
          {notice.text}
        </p>
      ) : null}

      <section className="mt-6">
        <h2 className="text-base font-semibold">POS staff</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          People who ring orders at the counter. Each signs in at the POS with
          their own 4-digit PIN.
        </p>
        <Card className="mt-4 gap-0! py-0!">
          {active.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">No active staff yet.</p>
          ) : null}
          {active.map((e, i) => (
            <div key={e.id} data-testid="employee-row" className={rowClass(i)}>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <span className="truncate">{e.name}</span>
                  <Badge variant={e.role === "cashier" ? "secondary" : "outline"} className="shrink-0">
                    {ROLE_LABEL[e.role]}
                  </Badge>
                </p>
              </div>
              <ChangePinForm employeeId={e.id} name={e.name} />
              <form action={deactivateEmployee}>
                <input type="hidden" name="employeeId" value={e.id} />
                <ConfirmButton label="Deactivate" confirmLabel="Confirm deactivate" />
              </form>
            </div>
          ))}
        </Card>
        {inactive.length > 0 ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
              Inactive ({inactive.length})
            </summary>
            <ul className="mt-2 space-y-1 pl-4 text-sm text-muted-foreground">
              {inactive.map((e) => (
                <li key={e.id}>
                  {e.name} · {ROLE_LABEL[e.role]}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <FieldSet className="mt-6 max-w-2xl">
          <FieldLegend className="w-full border-b border-border pb-2 text-sm!">
            Add an employee
          </FieldLegend>
          <AddEmployeeForm />
        </FieldSet>
      </section>

      <section className="mt-12">
        <h2 className="text-base font-semibold">Admin accounts</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Everyone listed here can sign in and manage the whole store: the
          menu, orders, staff, reports and settings.
        </p>
        <Card className="mt-4 gap-0! py-0!">
          {rows.map((row, i) => {
            const isYou = row.id === current.id;
            return (
              <div
                key={row.id}
                data-testid="operator-row"
                className={rowClass(i)}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{row.name}</span>
                    {isYou ? (
                      <Badge variant="secondary" className="shrink-0">
                        You
                      </Badge>
                    ) : null}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    {row.email}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Added {formatStoreDateTime(row.createdAt, tz)}
                </p>
                {/* No self-removal: it's what keeps at least one account alive. */}
                {isYou ? null : (
                  <form action={removeOperator}>
                    <input type="hidden" name="operatorId" value={row.id} />
                    <ConfirmButton label="Remove" confirmLabel="Confirm remove" />
                  </form>
                )}
              </div>
            );
          })}
        </Card>

        <div className="mt-8 max-w-2xl space-y-8">
          <FieldSet>
            <FieldLegend className="w-full border-b border-border pb-2 text-sm!">
              Add an operator
            </FieldLegend>
            <AddOperatorForm />
          </FieldSet>

          <FieldSet>
            <FieldLegend className="w-full border-b border-border pb-2 text-sm!">
              Change your password
            </FieldLegend>
            <ChangePasswordForm />
          </FieldSet>
        </div>
      </section>
    </div>
  );
}
