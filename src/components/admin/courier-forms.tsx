"use client";

import { useActionState } from "react";
import {
  cancelCourierDelivery,
  requestCourier,
  type CourierFormState,
} from "@/app/admin/actions";
import type { CourierProviderId } from "@/lib/delivery/types";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ConfirmButton } from "./confirm-button";

const INITIAL: CourierFormState = {};

export function RequestCourierForm({
  orderId,
  providers,
}: {
  orderId: string;
  providers: { id: CourierProviderId; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(requestCourier, INITIAL);
  const [only] = providers;

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      {providers.length > 1 ? (
        <NativeSelect name="provider" size="sm" aria-label="Courier provider">
          {providers.map((p) => (
            <NativeSelectOption key={p.id} value={p.id}>
              {p.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : (
        <input type="hidden" name="provider" value={only.id} />
      )}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending
          ? "Requesting…"
          : providers.length > 1
            ? "Request courier"
            : `Request ${only.label} courier`}
      </Button>
      {state.error ? <FieldError className="basis-full">{state.error}</FieldError> : null}
    </form>
  );
}

export function CancelCourierForm({ deliveryId }: { deliveryId: string }) {
  const [state, formAction] = useActionState(cancelCourierDelivery, INITIAL);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="deliveryId" value={deliveryId} />
      <ConfirmButton label="Cancel courier" confirmLabel="Confirm cancel" size="xs" />
      {state.error ? <FieldError className="basis-full">{state.error}</FieldError> : null}
    </form>
  );
}
