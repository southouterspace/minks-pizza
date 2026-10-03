import { getCurrentOperator } from "@/lib/auth";
import { kioskRequestSchema } from "@/lib/timeclock";
import { getStaffConfig } from "@/lib/staff/config";
import { applyKioskAction, employeeByPin, getKioskBoard, getKioskView } from "@/lib/staff/kiosk";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
// Both are 401s; `code` tells the tablet whether to shake or to sign in again.
const unauthorized = () => Response.json({ error: "Not signed in.", code: "signed_out" }, { status: 401 });

/** The PIN pad polls this for the clock and the on-shift count. */
export async function GET(): Promise<Response> {
  if (!(await getCurrentOperator())) return unauthorized();
  return Response.json(await getKioskBoard(await getStaffConfig()), { headers: noStore });
}

/**
 * Identifies an employee by PIN and, with an action, applies it. The PIN
 * travels with every request: the tablet never holds an employee session.
 */
export async function POST(request: Request): Promise<Response> {
  if (!(await getCurrentOperator())) return unauthorized();
  const parsed = kioskRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });

  const [employee, cfg] = await Promise.all([employeeByPin(parsed.data.pin), getStaffConfig()]);
  if (!employee) return Response.json({ error: "PIN not recognized.", code: "bad_pin" }, { status: 401, headers: noStore });

  const body = parsed.data.action
    ? await applyKioskAction(employee, parsed.data.action, cfg)
    : { view: await getKioskView(employee, cfg), message: null, tone: "info" as const, summary: null };
  return Response.json(body, { headers: noStore });
}
