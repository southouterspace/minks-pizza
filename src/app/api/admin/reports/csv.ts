import { getCurrentOperator } from "@/lib/auth";
import { getStoreBasics, type ReportScope } from "@/lib/orders-server";
import { resolveScope } from "@/lib/reports-server";

/** Operator-only CSV download for `?shift=<id>` or `?date=YYYY-MM-DD`. */
export async function csvResponse(
  request: Request,
  name: string,
  build: (scope: ReportScope, tz: string) => Promise<string>,
): Promise<Response> {
  if (!(await getCurrentOperator())) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  const { timezone } = await getStoreBasics();
  const resolved = await resolveScope({ shift: params.get("shift"), date: params.get("date") }, timezone);
  if (!resolved) {
    return Response.json({ error: "Pass ?shift=<shift id> or ?date=YYYY-MM-DD." }, { status: 400 });
  }
  return new Response(await build(resolved.scope, timezone), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="minks-${name}-${resolved.label}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
