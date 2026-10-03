import { getCurrentOperator } from "@/lib/auth";
import { getPosMenu } from "@/lib/menu-server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!(await getCurrentOperator())) return Response.json({ error: "Not signed in." }, { status: 401 });
  return Response.json(await getPosMenu(), { headers: { "Cache-Control": "no-store" } });
}
