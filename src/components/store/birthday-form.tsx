"use client";

import { useActionState } from "react";
import { saveBirthday } from "@/app/(store)/rewards/actions";
import { MONTHS } from "@/lib/loyalty";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export function BirthdayForm({ points }: { points: number }) {
  const [state, action, pending] = useActionState(saveBirthday, {});
  return (
    <form action={action} className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Get {points} points in your birthday month. It arrives once a year when your birthday was set at least 30
        days before and you&apos;ve ordered in the past year. You can set it once.
      </p>
      {/* React resets the form after the action; the key remounts the selects with the last pick as their default. */}
      <div key={`${state.month}-${state.day}`} className="flex gap-2">
        <NativeSelect name="month" aria-label="Birth month" required defaultValue={state.month ?? ""}>
          <NativeSelectOption value="" disabled>Month</NativeSelectOption>
          {MONTHS.map((m, i) => (
            <NativeSelectOption key={m} value={i + 1}>{m}</NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect name="day" aria-label="Birth day" required defaultValue={state.day ?? ""}>
          <NativeSelectOption value="" disabled>Day</NativeSelectOption>
          {Array.from({ length: 31 }, (_, i) => (
            <NativeSelectOption key={i} value={i + 1}>{i + 1}</NativeSelectOption>
          ))}
        </NativeSelect>
        <Button type="submit" variant="outline" className="h-9!" disabled={pending}>Save</Button>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive" data-testid="birthday-error">{state.error}</p>
      ) : null}
    </form>
  );
}
