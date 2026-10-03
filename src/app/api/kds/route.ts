import { z } from "zod";
import { getCurrentOperator } from "@/lib/auth";
import { KDS_VIEWS, type KdsAction } from "@/lib/kds";
import { applyKdsAction, getKdsSnapshot } from "@/lib/kds-server";

export const dynamic = "force-dynamic";

const actionSchema: z.ZodType<KdsAction> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("item"),
    itemId: z.number().int().positive(),
    stage: z.enum(["queued", "oven", "done"]),
  }),
  z.object({ type: z.literal("bump"), orderId: z.uuid(), view: z.enum(KDS_VIEWS) }),
  z.object({ type: z.literal("recall"), orderId: z.uuid() }),
  z.object({ type: z.literal("handoff"), orderId: z.uuid() }),
]);

const unauthorized = () => Response.json({ error: "Not signed in." }, { status: 401 });

/** The kitchen display polls this for its whole picture of the line. */
export async function GET(): Promise<Response> {
  if (!(await getCurrentOperator())) return unauthorized();
  return Response.json(await getKdsSnapshot(), {
    headers: { "Cache-Control": "no-store" },
  });
}

/** Applies one action and answers with the fresh snapshot, saving a poll. */
export async function POST(request: Request): Promise<Response> {
  if (!(await getCurrentOperator())) return unauthorized();
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid action." }, { status: 400 });
  }
  await applyKdsAction(parsed.data);
  return Response.json(await getKdsSnapshot(), {
    headers: { "Cache-Control": "no-store" },
  });
}
