import { createHmac } from "node:crypto";
import { z } from "zod";
import { dateOrNull, presentOnly, requestJson, secretsMatch, type Fetch } from "./http";
import {
  COURIER_PROVIDER_LABEL,
  CourierError,
  WebhookAuthError,
  type Address,
  type CourierProvider,
  type CourierSnapshot,
  type CourierStatus,
  type DeliveryRequest,
} from "./types";

export type UberDirectConfig = {
  customerId: string;
  clientId: string;
  clientSecret: string;
  webhookSigningKey: string;
  tokenUrl: string;
  sandbox: boolean;
};

const LABEL = COURIER_PROVIDER_LABEL.uber_direct;

const UBER_STATUSES = [
  "pending",
  "pickup",
  "pickup_complete",
  "dropoff",
  "delivered",
  "canceled",
  "returned",
] as const;
type UberStatus = (typeof UBER_STATUSES)[number];

const STATUS: Record<UberStatus, CourierStatus> = {
  pending: "requested",
  pickup: "assigned",
  pickup_complete: "picked_up",
  dropoff: "at_dropoff",
  delivered: "delivered",
  canceled: "canceled",
  returned: "returned",
};

const tokenSchema = z.object({ access_token: z.string(), expires_in: z.number() });

const quoteSchema = z.object({
  id: z.string(),
  fee: z.number(),
  currency: z.string(),
  dropoff_eta: z.string().nullish(),
  expires: z.string().nullish(),
});

const deliveryFields = {
  fee: z.number().nullish(),
  currency: z.string().nullish(),
  tracking_url: z.string().nullish(),
  courier: z.object({ name: z.string(), phone_number: z.string().nullish() }).nullish(),
  pickup_eta: z.string().nullish(),
  dropoff_eta: z.string().nullish(),
  external_id: z.string().nullish(),
};

const deliverySchema = z.object({ id: z.string(), status: z.enum(UBER_STATUSES), ...deliveryFields });

const webhookSchema = z.object({
  id: z.string().nullish(),
  kind: z.string(),
  delivery_id: z.string().nullish(),
  status: z.string().nullish(),
  created: z.string().nullish(),
  data: z.object(deliveryFields).nullish(),
});

function details(d: z.infer<z.ZodObject<typeof deliveryFields>>) {
  return {
    feeCents: d.fee ?? null,
    currency: d.currency ?? null,
    trackingUrl: d.tracking_url ?? null,
    courier: d.courier ? { name: d.courier.name, phone: d.courier.phone_number ?? null } : null,
    pickupEta: dateOrNull(d.pickup_eta),
    dropoffEta: dateOrNull(d.dropoff_eta),
  };
}

/** Uber takes addresses as JSON-encoded strings, not objects. */
function address(a: Address): string {
  return JSON.stringify({
    street_address: a.street,
    city: a.city,
    state: a.state,
    zip_code: a.zip,
    country: a.country,
  });
}

export function uberDirect(config: UberDirectConfig, fetchImpl: Fetch = globalThis.fetch): CourierProvider {
  const base = `https://api.uber.com/v1/customers/${config.customerId}`;
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now()) return token.value;
    const res = await fetchImpl(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "client_credentials",
        scope: "eats.deliveries",
      }),
    });
    if (!res.ok) throw new CourierError(`${LABEL}: token request failed (HTTP ${res.status})`);
    const body = tokenSchema.parse(await res.json());
    // Refresh a minute early so a token never expires mid-request.
    token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return token.value;
  }

  async function post(path: string, body: unknown): Promise<unknown> {
    const headers = { Authorization: `Bearer ${await accessToken()}` };
    return requestJson(fetchImpl, LABEL, `${base}${path}`, { method: "POST", headers, body });
  }

  return {
    id: "uber_direct",
    label: LABEL,

    async quote(req) {
      const q = quoteSchema.parse(
        await post("/delivery_quotes", {
          pickup_address: address(req.pickup.address),
          dropoff_address: address(req.dropoff.address),
          pickup_phone_number: req.pickup.phone,
          dropoff_phone_number: req.dropoff.phone,
          manifest_total_value: req.orderValueCents,
        }),
      );
      return {
        quoteId: q.id,
        feeCents: q.fee,
        currency: q.currency,
        dropoffEta: dateOrNull(q.dropoff_eta),
        expiresAt: dateOrNull(q.expires),
      };
    },

    async create(req, quote): Promise<CourierSnapshot> {
      const d = deliverySchema.parse(
        await post("/deliveries", {
          quote_id: quote.quoteId,
          external_id: req.externalId,
          idempotency_key: req.externalId,
          pickup_name: req.pickup.businessName ?? req.pickup.contactName,
          pickup_business_name: req.pickup.businessName,
          pickup_address: address(req.pickup.address),
          pickup_phone_number: req.pickup.phone,
          pickup_notes: req.pickup.instructions,
          dropoff_name: req.dropoff.contactName,
          dropoff_business_name: req.dropoff.businessName,
          dropoff_address: address(req.dropoff.address),
          dropoff_phone_number: req.dropoff.phone,
          dropoff_notes: req.dropoff.instructions,
          manifest_items: req.items.map((i) => ({ name: i.name, quantity: i.quantity, size: "small" })),
          manifest_total_value: req.orderValueCents,
          tip: req.tipCents,
          ...(config.sandbox
            ? { test_specifications: { robo_courier_specification: { mode: "auto" } } }
            : {}),
        }),
      );
      return { providerDeliveryId: d.id, status: STATUS[d.status], ...details(d) };
    },

    async cancel({ providerDeliveryId }) {
      await post(`/deliveries/${providerDeliveryId}/cancel`, {});
    },

    parseWebhook(headers, rawBody) {
      const signature = headers.get("x-uber-signature") ?? headers.get("x-postmates-signature");
      const expected = createHmac("sha256", config.webhookSigningKey).update(rawBody).digest("hex");
      if (!signature || !secretsMatch(signature.toLowerCase(), expected)) {
        throw new WebhookAuthError("Bad Uber Direct webhook signature");
      }

      const event = webhookSchema.parse(JSON.parse(rawBody));
      // event.courier_update fires every 20 seconds with a location; we
      // don't track the courier on a map.
      if (event.kind !== "event.delivery_status") return null;
      const native = UBER_STATUSES.find((s) => s === event.status);
      if (!native) return null;

      const deliveryId = event.delivery_id ?? null;
      return {
        dedupeKey: event.id ?? `${deliveryId}:${native}:${event.created}`,
        type: event.kind,
        externalId: event.data?.external_id ?? null,
        providerDeliveryId: deliveryId,
        snapshot: { ...(event.data ? presentOnly(details(event.data)) : {}), status: STATUS[native] },
      };
    },
  };
}
