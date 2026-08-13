"use client";

import { useRef, useState } from "react";
import { ImageUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";

export function LogoField({
  initialLogoUrl,
  initialUploadedUrl,
}: {
  /** Externally hosted logo, if the operator pasted a URL. */
  initialLogoUrl: string | null;
  /** `/api/logo?v=…` when an uploaded logo exists. */
  initialUploadedUrl: string | null;
}) {
  const [uploadedUrl, setUploadedUrl] = useState(initialUploadedUrl);
  const [logoUrl, setLogoUrl] = useState(initialLogoUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const preview = uploadedUrl || logoUrl;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/admin/logo", { method: "POST", body });
      const json = (await res.json()) as { url?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Upload failed.");
      setUploadedUrl(json.url ?? null);
      setLogoUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const remove = async () => {
    setError(null);
    setBusy(true);
    try {
      if (uploadedUrl) {
        const res = await fetch("/api/admin/logo", { method: "DELETE" });
        if (!res.ok) throw new Error("Couldn't remove the logo.");
      }
      setUploadedUrl(null);
      setLogoUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove the logo.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field>
      <FieldLabel htmlFor="logo-url">Logo</FieldLabel>

      {/* Only the external URL travels with the settings form; uploads go
          straight to /api/admin/logo so they aren't limited by the server
          action body size. */}
      <input type="hidden" name="logoUrl" value={uploadedUrl ? "" : logoUrl} />

      <div className="flex items-start gap-4">
        <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
          {preview ? (
            // Operator-supplied image of unknown origin — a plain <img> avoids
            // next/image remote-pattern configuration.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt="Current logo"
              className="size-full object-contain"
            />
          ) : (
            <span className="text-xs text-muted-foreground">None</span>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <ImageUp />
              {busy ? "Uploading…" : uploadedUrl ? "Replace image" : "Upload image"}
            </Button>
            {preview ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={remove}
              >
                <Trash2 />
                Remove
              </Button>
            ) : null}
          </div>

          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            className="hidden"
            onChange={(e) => upload(e.target.files?.[0])}
          />

          <Input
            id="logo-url"
            type="text"
            inputMode="url"
            placeholder="…or paste an image URL (https://…)"
            value={uploadedUrl ? "" : logoUrl}
            disabled={Boolean(uploadedUrl)}
            onChange={(e) => setLogoUrl(e.target.value.trim())}
          />
        </div>
      </div>

      <FieldDescription>
        {uploadedUrl
          ? "Uploaded and saved. Shown at its natural shape in the storefront header and coming-soon page."
          : "Shown in the storefront header and on the coming-soon page. PNG, JPEG, WebP, GIF or SVG, up to 4 MB."}
      </FieldDescription>
      {error ? <FieldError errors={[{ message: error }]} /> : null}
    </Field>
  );
}
