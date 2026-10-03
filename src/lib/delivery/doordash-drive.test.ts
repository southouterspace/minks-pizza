import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { doordashDrive, type DoorDashDriveConfig } from "./doordash-drive";
import { REQUEST, stubFetch } from "./test-fixtures";
import { WebhookAuthError } from "./types";

const CONFIG: DoorDashDriveConfig = {
  developerId: "dev_1",
  keyId: "key_1",
  // base64url of the bytes fb ef be ff ("++++/w==" in standard base64).
  signingSecret: "----_w",
  webhookAuth: "Basic ZGQ6aG9vaw==",
};

const RESPONSE = {
  external_delivery_id: REQUEST.externalId,
  delivery_status: "quote",
  fee: 975,
  currency: "USD",
  dropoff_time_estimated: "2026-10-03T18:40:00Z",
};

describe("DoorDash Drive auth", () => {
  it("signs a DD-JWT-V1 token with the decoded secret", async () => {
    const { fetch, calls } = stubFetch([RESPONSE]);
    await doordashDrive(CONFIG, fetch).quote(REQUEST);

    const token = calls[0].headers.get("authorization")!.replace(/^Bearer /, "");
    assert.deepEqual(decodeProtectedHeader(token), { alg: "HS256", typ: "JWT", "dd-ver": "DD-JWT-V1" });
    const claims = decodeJwt(token);
    assert.equal(claims.aud, "doordash");
    assert.equal(claims.iss, "dev_1");
    assert.equal(claims.kid, "key_1");
    assert.equal(claims.exp! - claims.iat!, 300);
    await jwtVerify(token, Buffer.from("++++/w==", "base64"), { audience: "doordash" });
  });
});

describe("DoorDash Drive quote and create", () => {
  it("quotes, then accepts the quote", async () => {
    const { fetch, calls } = stubFetch([
      RESPONSE,
      {
        ...RESPONSE,
        delivery_status: "created",
        tracking_url: "https://doordash.com/drive/portal/track/abc",
      },
    ]);
    const dd = doordashDrive(CONFIG, fetch);

    const quote = await dd.quote(REQUEST);
    assert.deepEqual(quote, {
      quoteId: "6f1c2c1e-1f7a-4a39-9d43-2a6f3b8f9e10",
      feeCents: 975,
      currency: "USD",
      dropoffEta: new Date("2026-10-03T18:40:00Z"),
      expiresAt: null,
    });
    assert.equal(calls[0].url, "https://openapi.doordash.com/drive/v2/quotes");
    assert.deepEqual(JSON.parse(calls[0].body), {
      external_delivery_id: "6f1c2c1e-1f7a-4a39-9d43-2a6f3b8f9e10",
      pickup_address: "100 Main St, Springfield, IL 62701",
      pickup_business_name: "Mink's Pizza",
      pickup_phone_number: "+15550100000",
      dropoff_address: "12 Elm St, Apt 4, Springfield, IL 62704",
      dropoff_phone_number: "+15552223333",
      dropoff_instructions: "Ring twice",
      dropoff_contact_given_name: "Ada Lovelace",
      order_value: 3250,
      tip: 0,
      items: [{ name: "Large Pepperoni", quantity: 2 }],
    });

    assert.deepEqual(await dd.create(REQUEST, quote), {
      providerDeliveryId: "6f1c2c1e-1f7a-4a39-9d43-2a6f3b8f9e10",
      status: "requested",
      feeCents: 975,
      currency: "USD",
      trackingUrl: "https://doordash.com/drive/portal/track/abc",
      courier: null,
      pickupEta: null,
      dropoffEta: new Date("2026-10-03T18:40:00Z"),
    });
    assert.equal(
      calls[1].url,
      "https://openapi.doordash.com/drive/v2/quotes/6f1c2c1e-1f7a-4a39-9d43-2a6f3b8f9e10/accept",
    );
    assert.deepEqual(JSON.parse(calls[1].body), { tip: 0 });
  });
});

describe("DoorDash Drive webhook", () => {
  const dd = doordashDrive(CONFIG);
  const headers = new Headers({ authorization: "Basic ZGQ6aG9vaw==" });
  const event = (eventName: string) =>
    JSON.stringify({
      event_name: eventName,
      created_at: "2026-10-03T18:20:00.123Z",
      external_delivery_id: "6f1c2c1e-1f7a-4a39-9d43-2a6f3b8f9e10",
      dasher_id: 42,
      dasher_name: "Sam",
      dasher_dropoff_phone_number: "+15555550111",
      tracking_url: "https://doordash.com/drive/portal/track/abc",
      fee: 975,
      currency: "USD",
    });

  it("rejects the wrong authorization header", () => {
    assert.throws(
      () => dd.parseWebhook(new Headers({ authorization: "Basic bm9wZQ==" }), event("DASHER_PICKED_UP")),
      WebhookAuthError,
    );
    assert.throws(() => dd.parseWebhook(new Headers(), event("DASHER_PICKED_UP")), WebhookAuthError);
  });

  it("maps DASHER_PICKED_UP", () => {
    assert.deepEqual(dd.parseWebhook(headers, event("DASHER_PICKED_UP")), {
      dedupeKey: "6f1c2c1e-1f7a-4a39-9d43-2a6f3b8f9e10:DASHER_PICKED_UP:2026-10-03T18:20:00.123Z",
      type: "DASHER_PICKED_UP",
      externalId: "6f1c2c1e-1f7a-4a39-9d43-2a6f3b8f9e10",
      providerDeliveryId: "6f1c2c1e-1f7a-4a39-9d43-2a6f3b8f9e10",
      snapshot: {
        status: "picked_up",
        feeCents: 975,
        currency: "USD",
        trackingUrl: "https://doordash.com/drive/portal/track/abc",
        courier: { name: "Sam", phone: "+15555550111" },
      },
    });
  });

  it("ignores events it doesn't track", () => {
    assert.equal(dd.parseWebhook(headers, event("DELIVERY_BATCHED")), null);
    assert.equal(dd.parseWebhook(headers, event("SOMETHING_NEW")), null);
  });
});
