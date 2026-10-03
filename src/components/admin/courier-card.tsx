import type { InferSelectModel } from "drizzle-orm";
import type { courierDeliveries } from "@/db";
import {
  COURIER_PROVIDER_LABEL,
  COURIER_STATUS_LABEL,
  isTerminal,
  type CourierProviderId,
} from "@/lib/delivery/types";
import { formatCents } from "@/lib/money";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CancelCourierForm, RequestCourierForm } from "./courier-forms";

export function CourierCard({
  orderId,
  delivery,
  providers,
  canRequest,
}: {
  orderId: string;
  delivery: InferSelectModel<typeof courierDeliveries> | undefined;
  providers: { id: CourierProviderId; label: string }[];
  canRequest: boolean;
}) {
  const live = delivery !== undefined && !isTerminal(delivery.status);
  const offerRequest = !live && canRequest && providers.length > 0;
  if (!delivery && !offerRequest) return null;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Courier</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {delivery ? (
          <div className="space-y-1">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{COURIER_PROVIDER_LABEL[delivery.provider]}</span>
              <Badge
                variant={
                  delivery.status === "canceled" || delivery.status === "returned"
                    ? "destructive"
                    : "secondary"
                }
              >
                {COURIER_STATUS_LABEL[delivery.status]}
              </Badge>
            </p>
            {delivery.feeCents !== null ? (
              <p className="tabular-nums text-muted-foreground">
                {formatCents(delivery.feeCents)} fee
              </p>
            ) : null}
            {delivery.courierName ? (
              <p>
                {delivery.courierName}
                {delivery.courierPhone ? (
                  <span className="text-muted-foreground"> · {delivery.courierPhone}</span>
                ) : null}
              </p>
            ) : null}
            {delivery.trackingUrl ? (
              <a
                href={delivery.trackingUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline-offset-4 hover:underline"
              >
                Track courier
              </a>
            ) : null}
          </div>
        ) : null}
        {live ? <CancelCourierForm deliveryId={delivery.id} /> : null}
        {offerRequest ? <RequestCourierForm orderId={orderId} providers={providers} /> : null}
      </CardContent>
    </Card>
  );
}
