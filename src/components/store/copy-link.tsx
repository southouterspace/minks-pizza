"use client";

import { useState, useSyncExternalStore } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A share link built from the current origin, with a copy button. */
export function CopyLink({ path }: { path: string }) {
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
  const url = `${origin}${path}`;
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <code data-testid="referral-link" className="min-w-0 flex-1 truncate rounded-lg border border-border bg-muted px-3 py-2 text-sm">
        {url}
      </code>
      <Button
        type="button"
        variant="outline"
        className="h-9! shrink-0"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
