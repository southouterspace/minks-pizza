"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Printer } from "lucide-react";
import { toast } from "sonner";
import { cancelOrder, type OrderActionState } from "@/app/admin/actions";
import { CANCEL_REASONS } from "@/lib/order-workflow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

type OrderAction = (prev: OrderActionState, formData: FormData) => Promise<OrderActionState>;

/** A form bound to an order action: failures surface as a toast, success can close a dialog. */
export function ActionForm({
  action,
  orderId,
  children,
  className,
  onSuccess,
}: {
  action: OrderAction;
  orderId: string;
  children: ReactNode;
  className?: string;
  onSuccess?: () => void;
}) {
  const [state, formAction] = useActionState(action, {});
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  });
  useEffect(() => {
    if (!state.at) return;
    if (state.error) toast.error(state.error);
    else onSuccessRef.current?.();
  }, [state]);
  return (
    <form action={formAction} className={className}>
      <input type="hidden" name="orderId" value={orderId} />
      {children}
    </form>
  );
}

/** Disabled while its form is in flight, so one device can't double-submit. */
export function SubmitButton({
  children,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || props.disabled} {...props}>
      {children}
    </Button>
  );
}

export function CancelOrderDialog({
  orderId,
  orderNumber,
  size = "sm",
}: {
  orderId: string;
  orderNumber: number;
  size?: "xs" | "sm" | "default";
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size={size} data-testid={`cancel-${orderNumber}`} />
        }
      >
        Cancel
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <ActionForm action={cancelOrder} orderId={orderId} onSuccess={() => setOpen(false)}>
          <DialogHeader>
            <DialogTitle>Cancel order #{orderNumber}?</DialogTitle>
            <DialogDescription>
              The customer&apos;s tracker shows the reason. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="my-4">
            <Field>
              <FieldLabel htmlFor={`reason-${orderId}`}>Reason</FieldLabel>
              <NativeSelect
                id={`reason-${orderId}`}
                name="reason"
                required
                defaultValue=""
                className="w-full"
              >
                <NativeSelectOption value="" disabled>
                  Pick a reason
                </NativeSelectOption>
                {CANCEL_REASONS.map((r) => (
                  <NativeSelectOption key={r} value={r}>
                    {r}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor={`detail-${orderId}`}>Details (optional)</FieldLabel>
              <Input id={`detail-${orderId}`} name="detail" maxLength={300} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>
              Keep order
            </DialogClose>
            <SubmitButton variant="destructive">Cancel order</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

export function PrintButton() {
  return (
    <Button variant="outline" size="sm" onClick={() => window.print()}>
      <Printer data-icon="inline-start" />
      Print ticket
    </Button>
  );
}
