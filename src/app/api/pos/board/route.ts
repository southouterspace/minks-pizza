import { getCurrentOperator } from "@/lib/auth";
import { getBoard } from "@/lib/orders-server";

export const dynamic = "force-dynamic";

/** Polled by the POS. Also fires scheduled orders that have come due. */
export async function GET(): Promise<Response> {
  if (!(await getCurrentOperator())) return Response.json({ error: "Not signed in." }, { status: 401 });
  return Response.json(await getBoard(), { headers: { "Cache-Control": "no-store" } });
}
