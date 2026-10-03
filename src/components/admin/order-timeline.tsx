import type { HistoryEntry } from "@/lib/orders";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "./ui";

/** The activity log (orderHistory), oldest first. */
export function OrderTimeline({ entries, timeZone }: { entries: HistoryEntry[]; timeZone: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="relative space-y-3 border-l pl-4" data-testid="timeline">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`} className="relative">
              <span
                className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-foreground/30"
                aria-hidden="true"
              />
              <p className="text-sm font-medium">{e.text}</p>
              <p className="text-xs text-muted-foreground">
                {[e.who, e.approvedBy ? `approved by ${e.approvedBy}` : null, formatDateTime(e.at, timeZone)]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
