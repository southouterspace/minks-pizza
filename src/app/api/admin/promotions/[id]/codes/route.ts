import { getCurrentOperator } from "@/lib/auth";
import { listCodes } from "@/lib/promotion-admin";

export const dynamic = "force-dynamic";

/** Every code of one promotion as CSV, for a mail merge or a partner hand-off. */
export async function GET(_request: Request, ctx: RouteContext<"/api/admin/promotions/[id]/codes">): Promise<Response> {
  if (!(await getCurrentOperator())) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found." }, { status: 404 });
  const rows = await listCodes(id);
  // Codes are [A-Z0-9-] only, so no field needs quoting.
  const lines = ["Code,Max uses,Uses", ...rows.map((r) => `${r.display},${r.maxUses ?? ""},${r.uses}`)];
  return new Response(`${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="promotion-${id}-codes.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
