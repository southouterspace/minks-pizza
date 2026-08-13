import { eq } from "drizzle-orm";
import { db, storeLogo, storeSettings } from "@/db";
import { getCurrentOperator } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Vercel's serverless request bodies top out around 4.5 MB. */
const MAX_BYTES = 4 * 1024 * 1024;

const ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

/** Uploads a new store logo. Replaces any existing one. */
export async function POST(request: Request): Promise<Response> {
  if (!(await getCurrentOperator())) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "No file uploaded." }, { status: 400 });
  }
  if (!ALLOWED.has(file.type)) {
    return Response.json(
      { error: "Use a PNG, JPEG, WebP, GIF or SVG image." },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return Response.json(
      { error: "That image is larger than 4 MB. Try a smaller file." },
      { status: 413 },
    );
  }

  const data = Buffer.from(await file.arrayBuffer()).toString("base64");
  const now = new Date();
  const row = {
    contentType: file.type,
    data,
    byteSize: file.size,
    updatedAt: now,
  };

  await db
    .insert(storeLogo)
    .values({ id: 1, ...row })
    .onConflictDoUpdate({ target: storeLogo.id, set: row });

  // Point settings at the upload; an external URL would otherwise still win.
  await db
    .update(storeSettings)
    .set({ logoUploadedAt: now, logoUrl: null, updatedAt: now })
    .where(eq(storeSettings.id, 1));

  return Response.json({ url: `/api/logo?v=${now.getTime()}` });
}

/** Removes the uploaded logo, falling back to the initial badge. */
export async function DELETE(): Promise<Response> {
  if (!(await getCurrentOperator())) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  await db.delete(storeLogo).where(eq(storeLogo.id, 1));
  await db
    .update(storeSettings)
    .set({ logoUploadedAt: null, updatedAt: new Date() })
    .where(eq(storeSettings.id, 1));

  return Response.json({ ok: true });
}
