import { eq } from "drizzle-orm";
import { db, storeLogo } from "@/db";

export const dynamic = "force-dynamic";

/**
 * Serves the uploaded store logo. Callers append `?v=<timestamp>` so the
 * response can be cached hard and still update the moment a new logo is saved.
 */
export async function GET(): Promise<Response> {
  const [logo] = await db
    .select()
    .from(storeLogo)
    .where(eq(storeLogo.id, 1));

  if (!logo) {
    return new Response("No logo set", { status: 404 });
  }

  const bytes = Buffer.from(logo.data, "base64");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": logo.contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${logo.updatedAt.getTime()}"`,
    },
  });
}
