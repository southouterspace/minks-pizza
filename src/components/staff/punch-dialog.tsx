"use client";

import { useActionState, useState } from "react";
import { Plus, X } from "lucide-react";
import { savePunch, type StaffFormState } from "@/app/admin/staff/actions";
import { ROLE_LABEL, type JobRole } from "@/lib/timeclock";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export type PunchEmployee = { id: number; name: string; roles: JobRole[] };

/** Times are `datetime-local` strings on the store's wall clock. */
export type PunchDraft = {
  id: number | null;
  employeeId: number | null;
  role: JobRole | null;
  clockIn: string;
  clockOut: string;
  breaks: { start: string; end: string; paid: boolean }[];
  tipsDollars: string;
  note: string;
  approved: boolean;
};

const INITIAL: StaffFormState = {};

/** Edit a punch or add a missed one. Every save needs a reason; it lands in the audit log. */
export function PunchDialog({
  punch,
  employees,
  trigger,
  triggerVariant = "outline",
}: {
  punch: PunchDraft;
  employees: PunchEmployee[];
  trigger: string;
  triggerVariant?: "outline" | "default";
}) {
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState(punch.employeeId === null ? String(employees[0]?.id ?? "") : String(punch.employeeId));
  // Stable keys so removing a middle break doesn't shift the inputs' defaults.
  const [breaks, setBreaks] = useState(() => punch.breaks.map((b, key) => ({ ...b, key })));
  const [state, formAction, pending] = useActionState(async (prev: StaffFormState, fd: FormData) => {
    const result = await savePunch(prev, fd);
    if (!result.error) setOpen(false);
    return result;
  }, INITIAL);
  const roles = employees.find((e) => String(e.id) === employeeId)?.roles ?? [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button type="button" variant={triggerVariant} size="sm" />}
        data-testid={punch.id === null ? "add-punch" : "edit-punch"}
      >
        {trigger}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{punch.id === null ? "Add missed punch" : "Edit punch"}</DialogTitle>
          <DialogDescription>
            {punch.approved ? "This punch is approved. Saving a change clears the approval. " : ""}
            Leave clock-out blank if they&apos;re still working.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="grid gap-4" data-testid="punch-form">
          {punch.id !== null ? <input type="hidden" name="entryId" value={punch.id} /> : null}
          <input type="hidden" name="breakCount" value={breaks.length} />
          <div className="grid grid-cols-2 gap-3">
            {punch.id === null ? (
              <Field>
                <FieldLabel htmlFor="p-employee">Employee</FieldLabel>
                <NativeSelect
                  id="p-employee"
                  name="employeeId"
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                  className="w-full"
                >
                  {employees.map((e) => (
                    <NativeSelectOption key={e.id} value={e.id}>
                      {e.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            ) : (
              <input type="hidden" name="employeeId" value={employeeId} />
            )}
            <Field>
              <FieldLabel htmlFor="p-role">Role</FieldLabel>
              <NativeSelect id="p-role" name="role" key={employeeId} defaultValue={punch.role ?? roles[0]} className="w-full">
                {roles.map((r) => (
                  <NativeSelectOption key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="p-in">Clock in</FieldLabel>
              <Input id="p-in" name="clockIn" type="datetime-local" required defaultValue={punch.clockIn} />
            </Field>
            <Field>
              <FieldLabel htmlFor="p-out">Clock out</FieldLabel>
              <Input id="p-out" name="clockOut" type="datetime-local" defaultValue={punch.clockOut} />
            </Field>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Breaks</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() =>
                  setBreaks((b) => [
                    ...b,
                    { start: punch.clockIn, end: punch.clockIn, paid: false, key: Math.max(-1, ...b.map((x) => x.key)) + 1 },
                  ])
                }
              >
                <Plus /> Add break
              </Button>
            </div>
            {breaks.length === 0 ? <p className="text-sm text-muted-foreground">No breaks.</p> : null}
            {breaks.map((b, i) => (
              <div key={b.key} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2">
                <Input
                  name={`break-start-${i}`}
                  type="datetime-local"
                  aria-label={`Break ${i + 1} start`}
                  required
                  defaultValue={b.start}
                  className="w-auto"
                />
                <span className="text-sm text-muted-foreground">to</span>
                <Input
                  name={`break-end-${i}`}
                  type="datetime-local"
                  aria-label={`Break ${i + 1} end`}
                  defaultValue={b.end}
                  className="w-auto"
                />
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name={`break-paid-${i}`} defaultChecked={b.paid} /> Paid
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove break ${i + 1}`}
                  onClick={() => setBreaks((all) => all.filter((_, j) => j !== i))}
                >
                  <X />
                </Button>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field>
              <FieldLabel htmlFor="p-tips">Tips ($)</FieldLabel>
              <Input id="p-tips" name="tips" type="number" min="0" step="0.01" defaultValue={punch.tipsDollars} />
            </Field>
            <Field className="col-span-2">
              <FieldLabel htmlFor="p-note">Note</FieldLabel>
              <Input id="p-note" name="note" maxLength={500} defaultValue={punch.note} />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="p-reason">Reason for the change</FieldLabel>
            <Input id="p-reason" name="reason" required maxLength={500} placeholder="Forgot to clock out" />
          </Field>
          {state.error ? <FieldError>{state.error}</FieldError> : null}
          <DialogFooter>
            <Button type="submit" disabled={pending} data-testid="punch-save">
              {pending ? "Saving…" : "Save punch"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
