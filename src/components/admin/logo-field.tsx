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

/** Longest edge of the stored logo, in pixels. */
const MAX_EDGE = 512;
/** Refuse anything that would bloat the settings row / server action payload. */
const MAX_STORED_BYTES = 400_000;

/**
 * Downscale an image file to a self-contained data URL.
 *
 * Inlining the logo keeps the platform dependency-free — no S3/Blob bucket to
 * provision — at the cost of a larger settings row, which is why it's capped.
 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file isn't a valid image."));
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));

        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Couldn't process that image."));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        // WebP keeps transparency and is much smaller than PNG; fall back to
        // PNG on the rare browser that can't encode it.
        let out = canvas.toDataURL("image/webp", 0.92);
        if (!out.startsWith("data:image/webp")) {
          out = canvas.toDataURL("image/png");
        }
        resolve(out);
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function LogoField({ initialLogoUrl }: { initialLogoUrl: string | null }) {
  const [logoUrl, setLogoUrl] = useState(initialLogoUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      if (dataUrl.length > MAX_STORED_BYTES) {
        setError(
          "That image is too detailed to inline. Try a simpler or smaller logo, or paste a hosted image URL instead.",
        );
      } else {
        setLogoUrl(dataUrl);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that image.");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const isData = logoUrl.startsWith("data:");

  return (
    <Field>
      <FieldLabel htmlFor="logo-url">Logo</FieldLabel>

      {/* The value actually submitted with the settings form. */}
      <input type="hidden" name="logoUrl" value={logoUrl} />

      <div className="flex items-start gap-4">
        <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
          {logoUrl ? (
            // Data/remote URL of unknown host — plain img avoids next/image
            // remote-pattern config.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
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
              {busy ? "Processing…" : "Upload image"}
            </Button>
            {logoUrl ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLogoUrl("");
                  setError(null);
                }}
              >
                <Trash2 />
                Remove
              </Button>
            ) : null}
          </div>

          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => onPick(e.target.files?.[0])}
          />

          <Input
            id="logo-url"
            type="text"
            inputMode="url"
            placeholder="…or paste an image URL (https://…)"
            value={isData ? "" : logoUrl}
            disabled={isData}
            onChange={(e) => setLogoUrl(e.target.value.trim())}
          />
        </div>
      </div>

      <FieldDescription>
        {isData
          ? "Uploaded image stored with your store settings. Remove it to paste a hosted URL instead."
          : "Shown in the storefront header and on the coming-soon page. Uploads are resized to 512px; square images look best."}
      </FieldDescription>
      {error ? <FieldError errors={[{ message: error }]} /> : null}
    </Field>
  );
}
