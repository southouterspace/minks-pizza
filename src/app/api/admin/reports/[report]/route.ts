import { getCurrentOperator } from "@/lib/auth";
import { csvResponse } from "@/lib/csv";
import { REPORTS } from "@/lib/inventory-reports";

export const dynamic = "force-dynamic";

/** Any report as CSV, from the same query string as its page. */
export async function GET(request: Request, ctx: RouteContext<"/api/admin/reports/[report]">): Promise<Response> {
  if (!(await getCurrentOperator())) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }
  const { report } = await ctx.params;
  const def = REPORTS.find((r) => r.slug === report);
  if (!def) return Response.json({ error: "No such report." }, { status: 404 });
  const { filename, header, rows } = await def.csv(new URL(request.url).searchParams);
  return csvResponse(filename, header, rows);
}
