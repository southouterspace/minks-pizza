import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { db, operators } from "@/db";
import { requireOperator } from "@/lib/auth";
import { removeOperator } from "@/app/admin/actions";
import { ConfirmButton } from "@/components/admin/confirm-button";
import {
  AddOperatorForm,
  ChangePasswordForm,
} from "@/components/admin/team-forms";
import { formatDateTime } from "@/components/admin/ui";
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
};

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const current = await requireOperator();
  const notice = NOTICES[String((await searchParams).notice ?? "")];

  const rows = await db
    .select({
      id: operators.id,
      name: operators.name,
      email: operators.email,
      createdAt: operators.createdAt,
    })
    .from(operators)
    .orderBy(asc(operators.id));

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Team</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Everyone listed here can sign in and manage the whole store — the menu,
        orders and settings. There are no limited roles.
      </p>

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

      <Card className="mt-6 gap-0! py-0!">
        {rows.map((row, i) => {
          const isYou = row.id === current.id;
          return (
            <div
              key={row.id}
              data-testid="operator-row"
              className={
                i === 0
                  ? "flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4"
                  : "flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-5 py-4"
              }
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
                Added {formatDateTime(row.createdAt)}
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
    </div>
  );
}
