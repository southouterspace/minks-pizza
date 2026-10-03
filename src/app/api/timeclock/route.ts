import { z } from "zod";
import { getCurrentOperator } from "@/lib/auth";
import { JOB_ROLES, type KioskRequest } from "@/lib/timeclock";
import { getStaffConfig } from "@/lib/staff/config";
import { applyKioskAction, employeeByPin, getKioskBoard, getKioskView } from "@/lib/staff/kiosk";
import { localDateSchema } from "@/lib/zoned";

export const dynamic = "force-dynamic";

const requestSchema: z.ZodType<KioskRequest> = z.object({
  pin: z.string().regex(/^\d{4,6}$/),
  action: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("clock_in"), role: z.enum(JOB_ROLES) }),
      z.object({ type: z.literal("start_break"), paid: z.boolean() }),
      z.object({ type: z.literal("end_break") }),
      z.object({ type: z.literal("clock_out"), declaredTipsCents: z.number().int().min(0).max(1_000_000) }),
      z.object({
        type: z.literal("request_time_off"),
        startDate: localDateSchema,
        endDate: localDateSchema,
        reason: z.string().trim().max(500),
      }),
    ])
    .optional(),
});

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
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });

  const employee = await employeeByPin(parsed.data.pin);
  if (!employee) return Response.json({ error: "PIN not recognized.", code: "bad_pin" }, { status: 401, headers: noStore });

  const cfg = await getStaffConfig();
  const body = parsed.data.action
    ? await applyKioskAction(employee, parsed.data.action, cfg)
    : { view: await getKioskView(employee, cfg), message: null, tone: "info" as const, summary: null };
  return Response.json(body, { headers: noStore });
}
