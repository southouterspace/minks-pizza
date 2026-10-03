import { z } from "zod";
import { ingestWebhook } from "@/lib/delivery/dispatch";
import { courierProvider } from "@/lib/delivery/providers";
import { COURIER_PROVIDERS, WebhookAuthError } from "@/lib/delivery/types";

export const dynamic = "force-dynamic";

/**
 * Courier status webhooks. Signatures cover the exact bytes sent, so the body
 * is read as text. Once an event is recorded the answer is 200 even if
 * applying it failed (the error stays on the event row); only a failure to
 * record it answers 500, which makes the provider retry.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const id = z.enum(COURIER_PROVIDERS).safeParse((await params).provider);
  if (!id.success || !courierProvider(id.data)) {
    return Response.json({ error: "Unknown provider." }, { status: 404 });
  }
  const rawBody = await request.text();
  try {
    await ingestWebhook(id.data, request.headers, rawBody);
  } catch (err) {
    if (err instanceof WebhookAuthError) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (err instanceof SyntaxError || err instanceof z.ZodError) {
      return Response.json({ error: "Malformed payload." }, { status: 400 });
    }
    throw err;
  }
  return Response.json({ ok: true });
}
