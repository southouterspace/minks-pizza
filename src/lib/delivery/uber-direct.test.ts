import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { REQUEST, stubFetch } from "./test-fixtures";
import { WebhookAuthError } from "./types";
import { uberDirect, type UberDirectConfig } from "./uber-direct";

const CONFIG: UberDirectConfig = {
  customerId: "cus_1",
  clientId: "client",
  clientSecret: "secret",
  webhookSigningKey: "whsec_test_key",
  tokenUrl: "https://auth.uber.com/oauth/v2/token",
  sandbox: false,
};

const TOKEN = { access_token: "tok_1", expires_in: 2592000 };
const QUOTE = {
  kind: "delivery_quote",
  id: "dqt_1",
  fee: 799,
  currency: "usd",
  dropoff_eta: "2026-10-03T18:30:00Z",
  expires: "2026-10-03T18:15:00Z",
};
const DELIVERY = {
  id: "del_abc",
  status: "pending",
  fee: 799,
  currency: "usd",
  tracking_url: "https://track.example/abc",
  courier: null,
  pickup_eta: "2026-10-03T18:10:00Z",
  dropoff_eta: "2026-10-03T18:30:00Z",
  external_id: REQUEST.externalId,
};

const BODY =
  '{"id":"evt_1","kind":"event.delivery_status","customer_id":"cus_1","delivery_id":"del_abc","status":"pickup_complete","created":"2026-10-03T18:00:00Z","data":{"id":"del_abc","status":"pickup_complete","external_id":"6f1c2c1e-1f7a-4a39-9d43-2a6f3b8f9e10","fee":799,"currency":"usd","tracking_url":"https://track.example/abc","courier":{"name":"Robo","phone_number":"+15555550100"},"dropoff_eta":"2026-10-03T18:25:00Z"}}';
// printf '%s' "$BODY" | openssl dgst -sha256 -hmac whsec_test_key
const SIGNATURE = "10c7a99ec8fdee7af8be623a30093cc632e95382a8c657ab125b32e4946e5f5f";

describe("Uber Direct quote and create", () => {
  it("authenticates once and sends addresses as JSON strings", async () => {
    const { fetch, calls } = stubFetch([TOKEN, QUOTE, DELIVERY]);
    const uber = uberDirect(CONFIG, fetch);

    const quote = await uber.quote(REQUEST);
    assert.deepEqual(quote, {
      quoteId: "dqt_1",
      feeCents: 799,
      currency: "usd",
      dropoffEta: new Date("2026-10-03T18:30:00Z"),
      expiresAt: new Date("2026-10-03T18:15:00Z"),
    });

    const snapshot = await uber.create(REQUEST, quote);
    assert.deepEqual(snapshot, {
      providerDeliveryId: "del_abc",
      status: "requested",
      feeCents: 799,
      currency: "usd",
      trackingUrl: "https://track.example/abc",
      courier: null,
      pickupEta: new Date("2026-10-03T18:10:00Z"),
      dropoffEta: new Date("2026-10-03T18:30:00Z"),
    });

    assert.equal(calls.length, 3, "one token request serves both calls");
    const [token, quoteCall, createCall] = calls;
    assert.equal(token.url, "https://auth.uber.com/oauth/v2/token");
    assert.equal(
      token.body,
      "client_id=client&client_secret=secret&grant_type=client_credentials&scope=eats.deliveries",
    );

    assert.equal(quoteCall.url, "https://api.uber.com/v1/customers/cus_1/delivery_quotes");
    assert.equal(quoteCall.headers.get("authorization"), "Bearer tok_1");
    assert.deepEqual(JSON.parse(quoteCall.body), {
      pickup_address:
        '{"street_address":["100 Main St"],"city":"Springfield","state":"IL","zip_code":"62701","country":"US"}',
      dropoff_address:
        '{"street_address":["12 Elm St","Apt 4"],"city":"Springfield","state":"IL","zip_code":"62704","country":"US"}',
      pickup_phone_number: "+15550100000",
      dropoff_phone_number: "+15552223333",
      manifest_total_value: 3250,
    });

    assert.equal(createCall.url, "https://api.uber.com/v1/customers/cus_1/deliveries");
    assert.deepEqual(JSON.parse(createCall.body), {
      quote_id: "dqt_1",
      external_id: "6f1c2c1e-1f7a-4a39-9d43-2a6f3b8f9e10",
      idempotency_key: "6f1c2c1e-1f7a-4a39-9d43-2a6f3b8f9e10",
      pickup_name: "Mink's Pizza",
      pickup_business_name: "Mink's Pizza",
      pickup_address:
        '{"street_address":["100 Main St"],"city":"Springfield","state":"IL","zip_code":"62701","country":"US"}',
      pickup_phone_number: "+15550100000",
      dropoff_name: "Ada Lovelace",
      dropoff_address:
        '{"street_address":["12 Elm St","Apt 4"],"city":"Springfield","state":"IL","zip_code":"62704","country":"US"}',
      dropoff_phone_number: "+15552223333",
      dropoff_notes: "Ring twice",
      manifest_items: [{ name: "Large Pepperoni", quantity: 2, size: "small" }],
      manifest_total_value: 3250,
      tip: 0,
    });
  });

  it("asks for a robo courier in sandbox mode", async () => {
    const { fetch, calls } = stubFetch([TOKEN, QUOTE, DELIVERY]);
    const uber = uberDirect({ ...CONFIG, sandbox: true }, fetch);
    await uber.create(REQUEST, await uber.quote(REQUEST));
    assert.deepEqual(JSON.parse(calls[2].body).test_specifications, {
      robo_courier_specification: { mode: "auto" },
    });
  });

  it("surfaces Uber's error message", async () => {
    const fetchStub = (async (url: string) =>
      String(url).endsWith("/token")
        ? Response.json(TOKEN)
        : Response.json(
            { kind: "error", code: "address_undeliverable", message: "The address is outside the delivery area" },
            { status: 400 },
          )) as typeof fetch;
    await assert.rejects(uberDirect(CONFIG, fetchStub).quote(REQUEST), {
      message: "Uber Direct: The address is outside the delivery area",
    });
  });
});

describe("Uber Direct webhook", () => {
  const uber = uberDirect(CONFIG);

  it("maps a signed delivery_status event", () => {
    assert.deepEqual(uber.parseWebhook(new Headers({ "x-uber-signature": SIGNATURE }), BODY), {
      dedupeKey: "evt_1",
      type: "event.delivery_status",
      externalId: "6f1c2c1e-1f7a-4a39-9d43-2a6f3b8f9e10",
      providerDeliveryId: "del_abc",
      snapshot: {
        status: "picked_up",
        feeCents: 799,
        currency: "usd",
        trackingUrl: "https://track.example/abc",
        courier: { name: "Robo", phone: "+15555550100" },
        dropoffEta: new Date("2026-10-03T18:25:00Z"),
      },
    });
  });

  it("accepts the legacy postmates header", () => {
    const update = uber.parseWebhook(new Headers({ "x-postmates-signature": SIGNATURE }), BODY);
    assert.equal(update?.snapshot.status, "picked_up");
  });

  it("rejects a tampered body", () => {
    const tampered = BODY.replace('"fee":799', '"fee":1');
    assert.throws(
      () => uber.parseWebhook(new Headers({ "x-uber-signature": SIGNATURE }), tampered),
      WebhookAuthError,
    );
  });

  it("rejects a missing signature", () => {
    assert.throws(() => uber.parseWebhook(new Headers(), BODY), WebhookAuthError);
  });

  it("ignores courier location updates", () => {
    const body = JSON.stringify({ id: "evt_2", kind: "event.courier_update", delivery_id: "del_abc" });
    const signature = createHmac("sha256", "whsec_test_key").update(body).digest("hex");
    assert.equal(uber.parseWebhook(new Headers({ "x-uber-signature": signature }), body), null);
  });
});
