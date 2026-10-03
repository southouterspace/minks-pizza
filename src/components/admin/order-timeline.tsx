import { describeEvent } from "@/lib/order-workflow";
import type { OrderDetail } from "@/lib/order-queries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "./ui";

/** The audit trail, oldest first. */
export function OrderTimeline({ order, timeZone }: { order: OrderDetail; timeZone: string }) {
  // Orders from before the audit trail have no "placed" row; show one anyway.
  const placed = order.events.some((e) => e.type === "placed")
    ? []
    : [
        {
          key: "placed",
          type: "placed" as const,
          fromStatus: null,
          toStatus: null,
          actor: "Customer",
          note: null,
          createdAt: order.placedAt,
        },
      ];
  const entries = [...placed, ...order.events.map((e) => ({ ...e, key: String(e.id) }))];

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="relative space-y-3 border-l pl-4" data-testid="timeline">
          {entries.map((e) => (
            <li key={e.key} className="relative">
              <span
                className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-foreground/30"
                aria-hidden="true"
              />
              <p className="text-sm">
                <span className="font-medium">{describeEvent(e)}</span>
                {e.note ? <span className="text-muted-foreground"> · {e.note}</span> : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {e.actor} · {formatDateTime(e.createdAt, timeZone)}
              </p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
