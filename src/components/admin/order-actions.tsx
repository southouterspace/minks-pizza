"use client";

import { useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Printer } from "lucide-react";
import { toast } from "sonner";
import {
  adjustPromisedTimeAction,
  cancelOrder,
  moveOrder,
  type OrderActionState,
} from "@/app/admin/actions";
import {
  canTransition,
  CANCEL_REASONS,
  isCooking,
  NEXT_ACTION,
  type OrderStatus,
} from "@/lib/order-workflow";
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

type OrderAction = (formData: FormData) => Promise<OrderActionState>;

/**
 * A form bound to an order action. Feedback runs from the submit handler,
 * not from component state: a successful move re-renders the board and
 * remounts the card in another lane, which would drop that state.
 */
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
  return (
    <form
      className={className}
      action={async (formData) => {
        const result = await action(formData);
        if (result.error) toast.error(result.error);
        else onSuccess?.();
      }}
    >
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

/** The order's one forward move, or nothing when it has none. */
export function AdvanceButton({
  orderId,
  status,
  size,
  testId,
}: {
  orderId: string;
  status: OrderStatus;
  size: "sm" | "default";
  testId: string;
}) {
  const next = NEXT_ACTION[status];
  if (!next) return null;
  return (
    <ActionForm action={moveOrder} orderId={orderId}>
      <input type="hidden" name="to" value={next.to} />
      <SubmitButton size={size} data-testid={testId}>
        {next.label}
      </SubmitButton>
    </ActionForm>
  );
}

/** Quick pushes to the promised time, offered only while the food is still owed. */
export function EtaButtons({
  orderId,
  orderNumber,
  status,
  minutes,
}: {
  orderId: string;
  orderNumber: number;
  status: OrderStatus;
  minutes: readonly number[];
}) {
  if (!isCooking(status)) return null;
  return minutes.map((m) => (
    <ActionForm key={m} action={adjustPromisedTimeAction} orderId={orderId}>
      <input type="hidden" name="minutes" value={m} />
      <SubmitButton
        variant="outline"
        size="sm"
        className="tabular-nums"
        aria-label={`${m > 0 ? "Push" : "Pull"} promised time ${Math.abs(m)} minutes`}
        data-testid={`eta${m}-${orderNumber}`}
      >
        {m > 0 ? `+${m}` : `−${-m}`} min
      </SubmitButton>
    </ActionForm>
  ));
}

export function CancelOrderDialog({
  orderId,
  orderNumber,
  status,
  size,
}: {
  orderId: string;
  orderNumber: number;
  status: OrderStatus;
  size: "sm" | "default";
}) {
  const [open, setOpen] = useState(false);
  if (!canTransition(status, "canceled")) return null;
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
