"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { sendCode, verifyCode } from "@/app/(store)/rewards/actions";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatPhone } from "@/lib/loyalty";

export function RewardsSignIn({ next, referralCode }: { next: string; referralCode: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const requestCode = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await sendCode(phone);
      if (!result.ok) return setError(result.error);
      setSentTo(result.phone);
      setDevCode(result.devCode ?? null);
      setCode("");
    });
  };

  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await verifyCode({
        phone: sentTo,
        code,
        name: name || undefined,
        referralCode: referralCode ?? undefined,
      });
      if (!result.ok) return setError(result.error);
      router.push(next);
      router.refresh();
    });
  };

  if (sentTo === null) {
    return (
      <form onSubmit={requestCode} className="space-y-4">
        <Field>
          <FieldLabel htmlFor="rw-phone">Phone number</FieldLabel>
          <Input
            id="rw-phone"
            type="tel"
            required
            autoComplete="tel"
            placeholder="(555) 555-0123"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <FieldDescription>We&apos;ll text you a 6-digit code. Use the number you order with.</FieldDescription>
        </Field>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" disabled={pending} className="h-10! w-full">
          {pending ? "Sending…" : "Text me a code"}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={verify} className="space-y-4">
      <p className="text-sm text-muted-foreground">
        We texted a code to <span className="font-medium text-foreground">{formatPhone(sentTo)}</span>.{" "}
        <button
          type="button"
          className="underline underline-offset-4 hover:text-foreground"
          onClick={() => {
            setSentTo(null);
            setError(null);
          }}
        >
          Change
        </button>
      </p>
      {devCode ? (
        <p data-testid="dev-code" className="rounded-lg bg-muted px-3 py-2 text-sm">
          Dev mode: your code is <span className="font-mono font-semibold">{devCode}</span>
        </p>
      ) : null}
      <Field>
        <FieldLabel htmlFor="rw-code">Code</FieldLabel>
        <Input
          id="rw-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          className="font-mono tracking-[0.3em]"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="rw-name">
          First name <span className="font-normal text-muted-foreground">(new members)</span>
        </FieldLabel>
        <Input id="rw-name" autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending || code.length !== 6} className="h-10! w-full">
        {pending ? "Checking…" : "Sign in"}
      </Button>
    </form>
  );
}
