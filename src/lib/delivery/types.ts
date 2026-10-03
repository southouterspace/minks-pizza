/**
 * Courier dispatch domain: the provider-neutral shapes every adapter speaks,
 * and the pure rules applied to them. No I/O, so tests and the schema can
 * import it freely.
 */
import type { orderItems, orders, storeSettings } from "@/db/schema";

export const ORDER_SOURCES = ["web", "walk_in", "phone", "doordash", "ubereats", "grubhub"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

export const COURIER_PROVIDERS = ["uber_direct", "doordash_drive"] as const;
export type CourierProviderId = (typeof COURIER_PROVIDERS)[number];

export const COURIER_PROVIDER_LABEL: Record<CourierProviderId, string> = {
  uber_direct: "Uber Direct",
  doordash_drive: "DoorDash Drive",
};

export const COURIER_STATUSES = [
  "requested",
  "assigned",
  "at_pickup",
  "picked_up",
  "at_dropoff",
  "delivered",
  "canceled",
  "returned",
] as const;
export type CourierStatus = (typeof COURIER_STATUSES)[number];

export const TERMINAL_COURIER_STATUSES = ["delivered", "canceled", "returned"] as const;

export const COURIER_STATUS_LABEL: Record<CourierStatus, string> = {
  requested: "Finding a courier",
  assigned: "Courier assigned",
  at_pickup: "Courier at the store",
  picked_up: "On the way",
  at_dropoff: "Arriving",
  delivered: "Delivered",
  canceled: "Canceled",
  returned: "Returned to store",
};

/** Canceled and returned outrank every in-flight state, so they always win. */
export const COURIER_STATUS_RANK: Record<CourierStatus, number> = {
  requested: 0,
  assigned: 1,
  at_pickup: 2,
  picked_up: 3,
  at_dropoff: 4,
  delivered: 5,
  canceled: 6,
  returned: 7,
};

export function isTerminal(status: CourierStatus): boolean {
  return (TERMINAL_COURIER_STATUSES as readonly CourierStatus[]).includes(status);
}

/**
 * Webhooks arrive out of order and get retried, so a status only moves
 * forward. Terminal states stick, except that a canceled delivery can still
 * come back as returned: the food was already in the car.
 */
export function advanceStatus(current: CourierStatus, incoming: CourierStatus): CourierStatus {
  if (isTerminal(current)) {
    return current === "canceled" && incoming === "returned" ? incoming : current;
  }
  return COURIER_STATUS_RANK[incoming] > COURIER_STATUS_RANK[current] ? incoming : current;
}

export type Address = {
  street: string[];
  city: string;
  state: string;
  zip: string;
  country: "US";
};

export type Stop = {
  businessName?: string;
  contactName: string;
  phone: string;
  address: Address;
  instructions?: string;
};

export type DeliveryRequest = {
  externalId: string;
  pickup: Stop;
  dropoff: Stop;
  orderValueCents: number;
  tipCents: number;
  items: { name: string; quantity: number }[];
};

export type CourierQuote = {
  quoteId: string;
  feeCents: number;
  currency: string;
  dropoffEta: Date | null;
  expiresAt: Date | null;
};

export type CourierSnapshot = {
  providerDeliveryId: string;
  status: CourierStatus;
  feeCents: number | null;
  currency: string | null;
  trackingUrl: string | null;
  courier: { name: string; phone: string | null } | null;
  pickupEta: Date | null;
  dropoffEta: Date | null;
};

export type CourierUpdate = {
  dedupeKey: string;
  type: string;
  externalId: string | null;
  providerDeliveryId: string | null;
  snapshot: Partial<Omit<CourierSnapshot, "providerDeliveryId">>;
};

export interface CourierProvider {
  id: CourierProviderId;
  label: string;
  quote(req: DeliveryRequest): Promise<CourierQuote>;
  create(req: DeliveryRequest, quote: CourierQuote): Promise<CourierSnapshot>;
  cancel(d: { id: string; providerDeliveryId: string }): Promise<void>;
  /** Throws WebhookAuthError on bad auth; null means an event we ignore. */
  parseWebhook(headers: Headers, rawBody: string): CourierUpdate | null;
}

/** A courier operation failed; the message is safe to show an operator. */
export class CourierError extends Error {}

export class WebhookAuthError extends Error {}

/**
 * The fields of an update worth writing over the current row, with the status
 * resolved through advanceStatus. An event older than the row's status
 * carries stale courier details, so they are dropped.
 */
export function courierPatch(
  current: CourierStatus,
  snapshot: CourierUpdate["snapshot"],
): CourierUpdate["snapshot"] {
  if (snapshot.status === undefined) return snapshot;
  const status = advanceStatus(current, snapshot.status);
  return status === snapshot.status ? { ...snapshot, status } : { status };
}

/** "(555) 123-4567" → "+15551234567". Both providers want E.164. */
export function e164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (phone.trim().startsWith("+") && digits.length >= 8) return `+${digits}`;
  throw new CourierError(`"${phone}" is not a phone number a courier can call.`);
}

type DispatchOrder = Pick<
  typeof orders.$inferSelect,
  | "id"
  | "customerName"
  | "customerPhone"
  | "addressLine1"
  | "addressLine2"
  | "city"
  | "zip"
  | "orderNotes"
  | "subtotalCents"
> & { items: Pick<typeof orderItems.$inferSelect, "itemName" | "quantity">[] };

type DispatchSettings = Pick<
  typeof storeSettings.$inferSelect,
  "name" | "phone" | "addressLine1" | "addressLine2" | "city" | "state" | "zip"
>;

export function deliveryRequestFor(
  order: DispatchOrder,
  settings: DispatchSettings,
): Omit<DeliveryRequest, "externalId"> {
  const { phone, addressLine1, city, state, zip } = settings;
  if (!phone || !addressLine1 || !city || !state || !zip) {
    throw new CourierError(
      "Add the store's phone and full address (street, city, state, ZIP) in Settings before requesting a courier.",
    );
  }
  if (!order.addressLine1 || !order.zip) {
    throw new CourierError("This order has no delivery address.");
  }
  const street = (line1: string, line2: string | null) => (line2 ? [line1, line2] : [line1]);
  return {
    pickup: {
      businessName: settings.name,
      contactName: settings.name,
      phone: e164(phone),
      address: { street: street(addressLine1, settings.addressLine2), city, state, zip, country: "US" },
    },
    dropoff: {
      contactName: order.customerName,
      phone: e164(order.customerPhone),
      address: {
        street: street(order.addressLine1, order.addressLine2),
        // Checkout makes city optional and orders have no state column; a
        // single store delivers locally, and the ZIP pins down the rest.
        city: order.city ?? city,
        state,
        zip: order.zip,
        country: "US",
      },
      instructions: order.orderNotes ?? undefined,
    },
    orderValueCents: order.subtotalCents,
    // The tip a customer adds on our site is for the store, not the courier.
    tipCents: 0,
    items: order.items.map((i) => ({ name: i.itemName, quantity: i.quantity })),
  };
}
