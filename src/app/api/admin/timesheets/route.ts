import { getCurrentOperator } from "@/lib/auth";
import { getStaffConfig, resolveWeek } from "@/lib/staff/config";
import { timesheetCsv } from "@/lib/staff/timesheet-csv";
import { getTimesheetWeek } from "@/lib/staff/timesheets";

export const dynamic = "force-dynamic";

/** Payroll CSV for `?week=YYYY-MM-DD` (snapped to the payroll week start). */
export async function GET(request: Request): Promise<Response> {
  if (!(await getCurrentOperator())) return Response.json({ error: "Not signed in." }, { status: 401 });
  const cfg = await getStaffConfig();
  const week = resolveWeek(new URL(request.url).searchParams.get("week"), cfg);
  const csv = timesheetCsv(await getTimesheetWeek(week, cfg), cfg.timezone);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="timesheets-${week}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
