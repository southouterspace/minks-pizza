import { SignJWT } from "jose";
import { z } from "zod";
import { dateOrNull, presentOnly, requestJson, secretsMatch, type Fetch } from "./http";
import {
  COURIER_PROVIDER_LABEL,
  WebhookAuthError,
  type Address,
  type CourierProvider,
  type CourierSnapshot,
  type CourierStatus,
} from "./types";

// Production access to Drive is currently closed, so this runs against the
// sandbox only (docs/delivery-platforms-research.md, B1).

export type DoorDashDriveConfig = {
  developerId: string;
  keyId: string;
  signingSecret: string;
  /** The literal Authorization header configured for webhooks in the portal. */
  webhookAuth: string;
};

const LABEL = COURIER_PROVIDER_LABEL.doordash_drive;
const BASE = "https://openapi.doordash.com/drive/v2";

const DOORDASH_STATUSES = [
  "quote",
  "created",
  "confirmed",
  "enroute_to_pickup",
  "arrived_at_pickup",
  "picked_up",
  "enroute_to_dropoff",
  "arrived_at_dropoff",
  "delivered",
  "cancelled",
  "enroute_to_return",
  "arrived_at_return",
  "returned",
] as const;
type DoorDashStatus = (typeof DOORDASH_STATUSES)[number];

const STATUS: Record<DoorDashStatus, CourierStatus> = {
  quote: "requested",
  created: "requested",
  confirmed: "assigned",
  enroute_to_pickup: "assigned",
  arrived_at_pickup: "at_pickup",
  picked_up: "picked_up",
  enroute_to_dropoff: "picked_up",
  arrived_at_dropoff: "at_dropoff",
  delivered: "delivered",
  cancelled: "canceled",
  // A return only happens after the delivery failed; returned follows.
  enroute_to_return: "canceled",
  arrived_at_return: "canceled",
  returned: "returned",
};

const EVENT_STATUS: Record<string, CourierStatus | null> = {
  DASHER_CONFIRMED: "assigned",
  DASHER_CONFIRMED_PICKUP_ARRIVAL: "at_pickup",
  DASHER_PICKED_UP: "picked_up",
  DASHER_CONFIRMED_DROPOFF_ARRIVAL: "at_dropoff",
  DASHER_DROPPED_OFF: "delivered",
  DELIVERY_CANCELLED: "canceled",
  DELIVERY_RETURN_INITIALIZED: null,
  DASHER_CONFIRMED_RETURN_ARRIVAL: null,
  DELIVERY_RETURNED: "returned",
  DELIVERY_BATCHED: null,
  dasher_enroute_to_pickup: null,
  dasher_enroute_to_dropoff: null,
  dasher_enroute_to_return: null,
};

const deliveryFields = {
  fee: z.number().nullish(),
  currency: z.string().nullish(),
  tracking_url: z.string().nullish(),
  dasher_name: z.string().nullish(),
  dasher_pickup_phone_number: z.string().nullish(),
  dasher_dropoff_phone_number: z.string().nullish(),
  pickup_time_estimated: z.string().nullish(),
  dropoff_time_estimated: z.string().nullish(),
};

const deliverySchema = z.object({
  external_delivery_id: z.string(),
  delivery_status: z.enum(DOORDASH_STATUSES),
  ...deliveryFields,
  fee: z.number(),
  currency: z.string(),
});

const webhookSchema = z.object({
  event_name: z.string(),
  created_at: z.string(),
  external_delivery_id: z.string(),
  ...deliveryFields,
});

function details(d: z.infer<z.ZodObject<typeof deliveryFields>>) {
  // The pickup number is the one the store calls; it reaches the same Dasher.
  const phone = d.dasher_pickup_phone_number ?? d.dasher_dropoff_phone_number ?? null;
  return {
    feeCents: d.fee ?? null,
    currency: d.currency ?? null,
    trackingUrl: d.tracking_url ?? null,
    courier: d.dasher_name ? { name: d.dasher_name, phone } : null,
    pickupEta: dateOrNull(d.pickup_time_estimated),
    dropoffEta: dateOrNull(d.dropoff_time_estimated),
  };
}

function oneLine(a: Address): string {
  return `${a.street.join(", ")}, ${a.city}, ${a.state} ${a.zip}`;
}

export function doordashDrive(
  config: DoorDashDriveConfig,
  fetchImpl: Fetch = globalThis.fetch,
): CourierProvider {
  // Node's base64 decoder also accepts the URL-safe alphabet.
  const key = Buffer.from(config.signingSecret, "base64");

  async function jwt(): Promise<string> {
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({ aud: "doordash", iss: config.developerId, kid: config.keyId, iat, exp: iat + 300 })
      .setProtectedHeader({ alg: "HS256", typ: "JWT", "dd-ver": "DD-JWT-V1" })
      .sign(key);
  }

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers = { Authorization: `Bearer ${await jwt()}` };
    return requestJson(fetchImpl, LABEL, `${BASE}${path}`, { method, headers, body });
  }

  return {
    id: "doordash_drive",
    label: LABEL,

    async quote(req) {
      const q = deliverySchema.parse(
        await call("POST", "/quotes", {
          external_delivery_id: req.externalId,
          pickup_address: oneLine(req.pickup.address),
          pickup_business_name: req.pickup.businessName,
          pickup_phone_number: req.pickup.phone,
          pickup_instructions: req.pickup.instructions,
          dropoff_address: oneLine(req.dropoff.address),
          dropoff_business_name: req.dropoff.businessName,
          dropoff_phone_number: req.dropoff.phone,
          dropoff_instructions: req.dropoff.instructions,
          dropoff_contact_given_name: req.dropoff.contactName,
          order_value: req.orderValueCents,
          tip: req.tipCents,
          items: req.items,
        }),
      );
      return {
        quoteId: q.external_delivery_id,
        feeCents: q.fee,
        currency: q.currency,
        dropoffEta: dateOrNull(q.dropoff_time_estimated),
        expiresAt: null,
      };
    },

    async create(req, quote): Promise<CourierSnapshot> {
      const d = deliverySchema.parse(
        await call("POST", `/quotes/${quote.quoteId}/accept`, { tip: req.tipCents }),
      );
      return {
        providerDeliveryId: d.external_delivery_id,
        status: STATUS[d.delivery_status],
        ...details(d),
      };
    },

    async cancel({ providerDeliveryId }) {
      await call("PUT", `/deliveries/${providerDeliveryId}/cancel`);
    },

    parseWebhook(headers, rawBody) {
      const auth = headers.get("authorization");
      if (!auth || !secretsMatch(auth, config.webhookAuth)) {
        throw new WebhookAuthError("Bad DoorDash Drive webhook authorization");
      }

      const event = webhookSchema.parse(JSON.parse(rawBody));
      const status = EVENT_STATUS[event.event_name] ?? null;
      if (!status) return null;
      return {
        dedupeKey: `${event.external_delivery_id}:${event.event_name}:${event.created_at}`,
        type: event.event_name,
        externalId: event.external_delivery_id,
        providerDeliveryId: event.external_delivery_id,
        snapshot: { ...presentOnly(details(event)), status },
      };
    },
  };
}
