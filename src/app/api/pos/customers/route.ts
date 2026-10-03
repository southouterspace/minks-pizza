import type { NextRequest } from "next/server";
import { lookupCustomer } from "@/lib/orders-server";
import { getStaff } from "@/lib/staff";

export const dynamic = "force-dynamic";

/** Caller lookup: name, saved addresses and recent orders for a phone number. */
export async function GET(request: NextRequest): Promise<Response> {
  if (!(await getStaff())) return Response.json({ error: "Terminal is locked." }, { status: 401 });
  const phone = request.nextUrl.searchParams.get("phone") ?? "";
  if (phone.replace(/\D/g, "").length < 7) {
    return Response.json({ error: "Enter at least 7 digits." }, { status: 400 });
  }
  return Response.json(await lookupCustomer(phone), { headers: { "Cache-Control": "no-store" } });
}
