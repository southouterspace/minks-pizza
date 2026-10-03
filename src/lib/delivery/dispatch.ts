import "server-only";
import { and, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import { courierDeliveries, db, integrationEvents, orders } from "@/db";
import { getSettings } from "@/lib/settings-server";
import { courierProvider } from "./providers";
import {
  CourierError,
  courierPatch,
  deliveryRequestFor,
  isTerminal,
  type CourierProviderId,
  type CourierUpdate,
} from "./types";

function requireProvider(id: CourierProviderId) {
  const provider = courierProvider(id);
  if (!provider) throw new CourierError(`${id} is not configured.`);
  return provider;
}

/**
 * Writes an update onto one courier row. The write is conditional on the
 * status it was computed from, so two webhooks racing on the same delivery
 * can't undo each other's progress; the loser rereads and tries again.
 */
async function applyToRow(
  where: [SQL, ...SQL[]],
  snapshot: CourierUpdate["snapshot"],
  providerDeliveryId?: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [row] = await db
      .select({ id: courierDeliveries.id, status: courierDeliveries.status })
      .from(courierDeliveries)
      .where(and(...where));
    if (!row) return false;
    const { courier, ...patch } = courierPatch(row.status, snapshot);
    const updated = await db
      .update(courierDeliveries)
      .set({
        ...patch,
        ...(courier !== undefined
          ? { courierName: courier?.name ?? null, courierPhone: courier?.phone ?? null }
          : {}),
        ...(providerDeliveryId ? { providerDeliveryId } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(courierDeliveries.id, row.id), eq(courierDeliveries.status, row.status)))
      .returning({ id: courierDeliveries.id });
    if (updated.length > 0) return true;
  }
  throw new Error("Courier delivery kept changing underneath the update");
}

export async function dispatchCourier(orderId: string, providerId: CourierProviderId): Promise<void> {
  const provider = requireProvider(providerId);
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
    with: { items: true },
  });
  if (!order) throw new CourierError("Order not found.");
  if (order.source !== "web" || order.orderType !== "delivery") {
    throw new CourierError("Only delivery orders placed on our site can get a courier.");
  }
  if (order.status === "completed" || order.status === "canceled") {
    throw new CourierError("This order is already closed.");
  }
  const base = deliveryRequestFor(order, await getSettings());

  // The row id is the external id the provider stores, so it exists first.
  // The partial unique index rejects a second live courier for the order.
  const [row] = await db
    .insert(courierDeliveries)
    .values({ orderId, provider: providerId })
    .onConflictDoNothing()
    .returning({ id: courierDeliveries.id });
  if (!row) throw new CourierError("This order already has a courier on the way.");

  const req = { ...base, externalId: row.id };
  const quote = await provider.quote(req).catch(async (err: unknown) => {
    await db.delete(courierDeliveries).where(eq(courierDeliveries.id, row.id));
    throw err;
  });
  const snapshot = await provider.create(req, quote).catch(async (err: unknown) => {
    // The provider may have created it before failing, so keep the row for
    // its webhooks to land on, but free the order for a retry.
    await db
      .update(courierDeliveries)
      .set({ status: "canceled", updatedAt: new Date() })
      .where(eq(courierDeliveries.id, row.id));
    throw err;
  });

  const { providerDeliveryId, ...fields } = snapshot;
  await applyToRow([eq(courierDeliveries.id, row.id)], fields, providerDeliveryId);
}

export async function cancelCourier(deliveryId: string): Promise<void> {
  const [row] = await db.select().from(courierDeliveries).where(eq(courierDeliveries.id, deliveryId));
  if (!row || isTerminal(row.status)) return;
  if (!row.providerDeliveryId) {
    throw new CourierError("The courier request is still being placed. Try again in a moment.");
  }
  await requireProvider(row.provider).cancel({ id: row.id, providerDeliveryId: row.providerDeliveryId });
  await applyToRow([eq(courierDeliveries.id, row.id)], { status: "canceled" });
}

/** Applies a parsed webhook; false when no delivery of ours matches it. */
export async function applyCourierUpdate(
  providerId: CourierProviderId,
  update: CourierUpdate,
): Promise<boolean> {
  const byId =
    update.externalId && z.uuid().safeParse(update.externalId).success
      ? eq(courierDeliveries.id, update.externalId)
      : null;
  const byProviderId = update.providerDeliveryId
    ? eq(courierDeliveries.providerDeliveryId, update.providerDeliveryId)
    : null;
  const where = byId ?? byProviderId;
  if (!where) return false;
  return applyToRow([where, eq(courierDeliveries.provider, providerId)], update.snapshot);
}

export type IngestResult = "ignored" | "duplicate" | "applied" | "failed";

/**
 * Records a webhook in the inbox, then applies it. Auth failures
 * (WebhookAuthError) and inbox write failures propagate to the caller;
 * processing failures are stored on the event row instead.
 */
export async function ingestWebhook(
  providerId: CourierProviderId,
  headers: Headers,
  rawBody: string,
): Promise<IngestResult> {
  const update = requireProvider(providerId).parseWebhook(headers, rawBody);
  if (!update) return "ignored";

  const [event] = await db
    .insert(integrationEvents)
    .values({
      source: providerId,
      dedupeKey: update.dedupeKey,
      type: update.type,
      payload: JSON.parse(rawBody),
    })
    .onConflictDoNothing()
    .returning({ id: integrationEvents.id });
  if (!event) return "duplicate";

  let error: string | null = null;
  try {
    if (!(await applyCourierUpdate(providerId, update))) error = "No matching courier delivery.";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  await db
    .update(integrationEvents)
    .set(error ? { error } : { processedAt: new Date() })
    .where(eq(integrationEvents.id, event.id));
  return error ? "failed" : "applied";
}
