import { asc, eq, sql } from "drizzle-orm";
import { db, orderDiscounts, orders, promotionCodes } from "@/db";
import { getCurrentOperator } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Every code of one promotion as CSV, for a mail merge or a partner hand-off. */
export async function GET(_request: Request, ctx: RouteContext<"/api/admin/promotions/[id]/codes">): Promise<Response> {
  if (!(await getCurrentOperator())) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Not found." }, { status: 404 });
  const rows = await db
    .select({
      display: promotionCodes.display,
      maxUses: promotionCodes.maxUses,
      uses: sql<number>`(select count(*) from ${orderDiscounts} d join ${orders} o on o.id = d.order_id
        where d.code_id = promotion_codes.id and o.status <> 'canceled')`.mapWith(Number),
    })
    .from(promotionCodes)
    .where(eq(promotionCodes.promotionId, id))
    .orderBy(asc(promotionCodes.id));
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
