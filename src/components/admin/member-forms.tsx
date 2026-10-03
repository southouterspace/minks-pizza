"use client";

import {
  addMissingOrder,
  adjustPoints,
  issueBirthdayBonus,
  saveMemberBirthday,
} from "@/app/admin/loyalty/actions";
import { FieldMessage, FormStatus, useLoyaltyForm } from "@/components/admin/loyalty-form";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function AdjustPointsForm({ memberId }: { memberId: number }) {
  const { key, formAction, pending, state, text, error } = useLoyaltyForm(adjustPoints);
  return (
    <form key={key} action={formAction} className="space-y-3" data-testid="adjust-form">
      <input type="hidden" name="memberId" value={memberId} />
      <Field>
        <FieldLabel htmlFor="adj-points">Points (use − to remove)</FieldLabel>
        <Input id="adj-points" name="points" type="number" step="1" required placeholder="50 or -50" defaultValue={text("points", "")} />
        <FieldMessage message={error("points")} />
      </Field>
      <Field>
        <FieldLabel htmlFor="adj-reason">Reason</FieldLabel>
        <Input id="adj-reason" name="reason" required maxLength={200} placeholder="Late delivery" defaultValue={text("reason", "")} />
        <FieldMessage message={error("reason")} />
      </Field>
      <Button type="submit" className="h-9!" disabled={pending}>Adjust points</Button>
      <FormStatus state={state} />
    </form>
  );
}

export function MemberBirthdayForms({
  memberId,
  birthMonth,
  birthDay,
  birthdayPoints,
}: {
  memberId: number;
  birthMonth: number | null;
  birthDay: number | null;
  birthdayPoints: number;
}) {
  const save = useLoyaltyForm(saveMemberBirthday);
  const issue = useLoyaltyForm(issueBirthdayBonus);
  return (
    <>
      <form key={save.key} action={save.formAction} className="space-y-3" data-testid="birthday-form">
        <input type="hidden" name="memberId" value={memberId} />
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="bd-month">Month</FieldLabel>
            <Input id="bd-month" name="month" type="number" min={1} max={12} required defaultValue={save.text("month", birthMonth)} />
            <FieldMessage message={save.error("month")} />
          </Field>
          <Field>
            <FieldLabel htmlFor="bd-day">Day</FieldLabel>
            <Input id="bd-day" name="day" type="number" min={1} max={31} required defaultValue={save.text("day", birthDay)} />
            <FieldMessage message={save.error("day")} />
          </Field>
        </div>
        <Button type="submit" variant="outline" className="h-9!" disabled={save.pending}>Save birthday</Button>
        <FormStatus state={save.state} />
      </form>
      <form action={issue.formAction} className="mt-4 space-y-2 border-t border-border pt-4" data-testid="issue-birthday-form">
        <input type="hidden" name="memberId" value={memberId} />
        <Button type="submit" variant="outline" className="h-9!" disabled={issue.pending}>
          Issue birthday bonus ({birthdayPoints} pts)
        </Button>
        <p className="text-xs text-muted-foreground">Once a year, whether or not it arrived on its own.</p>
        <FormStatus state={issue.state} />
      </form>
    </>
  );
}

export function MissingOrderForm({ memberId }: { memberId: number }) {
  const { key, formAction, pending, state, text, error } = useLoyaltyForm(addMissingOrder);
  return (
    <form key={key} action={formAction} className="flex flex-wrap items-end gap-3" data-testid="claim-form">
      <input type="hidden" name="memberId" value={memberId} />
      <Field className="w-40!">
        <FieldLabel htmlFor="claim-order">Order number</FieldLabel>
        <Input id="claim-order" name="orderNumber" inputMode="numeric" required placeholder="1042" defaultValue={text("orderNumber", "")} />
      </Field>
      <Button type="submit" variant="outline" className="h-9!" disabled={pending}>Add order</Button>
      <div className="basis-full space-y-1">
        <FieldMessage message={error("orderNumber")} />
        <FormStatus state={state} />
        <p className="text-xs text-muted-foreground">
          For a completed order placed without their phone or before they joined. It earns at the base rate.
        </p>
      </div>
    </form>
  );
}
