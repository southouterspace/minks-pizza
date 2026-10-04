"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Gift } from "lucide-react";
import { sendOrderCode, verifyOrderCode } from "@/app/(store)/rewards/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/** Join or confirm from the order page, with a code texted to the order's phone. */
export function OrderRewardsJoin({
  orderId,
  phoneLast4,
  title,
  body,
  action,
}: {
  orderId: string;
  phoneLast4: string;
  title: string;
  body: string;
  action: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const requestCode = () => {
    setError(null);
    startTransition(async () => {
      const result = await sendOrderCode(orderId);
      if (!result.ok) return setError(result.error);
      setSent(true);
      setDevCode(result.devCode ?? null);
      setCode("");
    });
  };

  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await verifyOrderCode({ orderId, code });
      if (!result.ok) return setError(result.error);
      router.refresh();
    });
  };

  return (
    <section data-testid="order-rewards-join" className="mt-6 rounded-xl border border-border p-4 text-sm">
      <h2 className="flex items-center gap-2 font-semibold">
        <Gift className="size-4 shrink-0" aria-hidden />
        {title}
      </h2>
      <p className="mt-1.5 text-muted-foreground">{body}</p>

      {!sent ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={requestCode} disabled={pending}>
            {pending ? "Sending…" : action}
          </Button>
          <span className="text-xs text-muted-foreground">We&apos;ll text a code to the number ending in {phoneLast4}.</span>
        </div>
      ) : (
        <form onSubmit={verify} className="mt-4 space-y-3">
          {devCode ? (
            <p data-testid="dev-code" className="rounded-lg bg-muted px-3 py-2">
              Dev mode: your code is <span className="font-mono font-semibold">{devCode}</span>
            </p>
          ) : null}
          <Field>
            <FieldLabel htmlFor="order-rw-code">Code texted to the number ending in {phoneLast4}</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="order-rw-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="max-w-40 font-mono tracking-[0.3em]"
              />
              <Button type="submit" disabled={pending || code.length !== 6}>
                {pending ? "Checking…" : "Confirm"}
              </Button>
            </div>
          </Field>
          <button
            type="button"
            onClick={requestCode}
            disabled={pending}
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Send a new code
          </button>
        </form>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
