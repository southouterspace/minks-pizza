import { submitOrderSchema } from "@/lib/validation";
import { submitOrder } from "@/lib/orders-server";
import { getStaff } from "@/lib/staff";

export const dynamic = "force-dynamic";

/**
 * The POS submit. A route handler, not a server action, because the offline
 * outbox replays this exact body after a deploy, when action ids have
 * changed. Replays return the stored order and write nothing.
 */
export async function POST(request: Request): Promise<Response> {
  const staff = await getStaff();
  if (!staff) return Response.json({ ok: false, reason: "locked" }, { status: 401 });
  const parsed = submitOrderSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { ok: false, reason: "rejected", message: parsed.error.issues[0]?.message ?? "Invalid order." },
      { status: 400 },
    );
  }
  const result = await submitOrder(parsed.data, { kind: "pos", staff });
  return Response.json(result, { status: result.ok ? 200 : 422 });
}
