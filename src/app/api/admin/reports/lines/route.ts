import { orderLinesCsv } from "@/lib/reports-server";
import { csvResponse } from "../csv";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return csvResponse(request, "order-lines", orderLinesCsv);
}
