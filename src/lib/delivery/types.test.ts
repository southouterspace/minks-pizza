import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advanceStatus, courierPatch, CourierError, deliveryRequestFor, e164 } from "./types";

describe("advanceStatus", () => {
  it("never regresses when an older event arrives late", () => {
    assert.equal(advanceStatus("picked_up", "assigned"), "picked_up");
    assert.equal(advanceStatus("assigned", "picked_up"), "picked_up");
    assert.equal(advanceStatus("at_dropoff", "at_dropoff"), "at_dropoff");
  });

  it("keeps terminal states", () => {
    assert.equal(advanceStatus("delivered", "canceled"), "delivered");
    assert.equal(advanceStatus("delivered", "at_dropoff"), "delivered");
    assert.equal(advanceStatus("canceled", "assigned"), "canceled");
    assert.equal(advanceStatus("returned", "canceled"), "returned");
  });

  it("lets cancel beat any in-flight state", () => {
    assert.equal(advanceStatus("at_dropoff", "canceled"), "canceled");
    assert.equal(advanceStatus("requested", "returned"), "returned");
  });

  it("lets a canceled delivery come back as returned", () => {
    assert.equal(advanceStatus("canceled", "returned"), "returned");
  });
});

describe("courierPatch", () => {
  it("drops the courier details of a stale event", () => {
    assert.deepEqual(
      courierPatch("picked_up", { status: "assigned", courier: { name: "Old", phone: null } }),
      { status: "picked_up" },
    );
  });

  it("keeps the details of a current event", () => {
    assert.deepEqual(courierPatch("assigned", { status: "picked_up", trackingUrl: "https://t/1" }), {
      status: "picked_up",
      trackingUrl: "https://t/1",
    });
  });
});

describe("e164", () => {
  it("normalizes US numbers", () => {
    assert.equal(e164("(555) 123-4567"), "+15551234567");
    assert.equal(e164("1 555 123 4567"), "+15551234567");
    assert.equal(e164("+44 20 7946 0958"), "+442079460958");
  });

  it("rejects numbers a courier can't call", () => {
    assert.throws(() => e164("12345"), CourierError);
  });
});

const settings = {
  name: "Mink's Pizza",
  phone: "(555) 010-0000",
  addressLine1: "100 Main St",
  addressLine2: null,
  city: "Springfield",
  state: "IL",
  zip: "62701",
};

const order = {
  id: "6f1c2c1e-1f7a-4a39-9d43-2a6f3b8f9e10",
  customerName: "Ada Lovelace",
  customerPhone: "555.222.3333",
  addressLine1: "12 Elm St",
  addressLine2: "Apt 4",
  city: null,
  zip: "62704",
  orderNotes: "Ring twice",
  subtotalCents: 3250,
  items: [
    { itemName: "Large Pepperoni", quantity: 2 },
    { itemName: "Garlic Knots", quantity: 1 },
  ],
};

describe("deliveryRequestFor", () => {
  it("builds pickup from the store and dropoff from the order", () => {
    assert.deepEqual(deliveryRequestFor(order, settings), {
      pickup: {
        businessName: "Mink's Pizza",
        contactName: "Mink's Pizza",
        phone: "+15550100000",
        address: { street: ["100 Main St"], city: "Springfield", state: "IL", zip: "62701", country: "US" },
      },
      dropoff: {
        contactName: "Ada Lovelace",
        phone: "+15552223333",
        address: {
          street: ["12 Elm St", "Apt 4"],
          city: "Springfield",
          state: "IL",
          zip: "62704",
          country: "US",
        },
        instructions: "Ring twice",
      },
      orderValueCents: 3250,
      tipCents: 0,
      items: [
        { name: "Large Pepperoni", quantity: 2 },
        { name: "Garlic Knots", quantity: 1 },
      ],
    });
  });

  it("refuses when the store has no address", () => {
    assert.throws(
      () => deliveryRequestFor(order, { ...settings, addressLine1: null }),
      /store's phone and full address/,
    );
  });

  it("refuses when the order has no address", () => {
    assert.throws(
      () => deliveryRequestFor({ ...order, addressLine1: null }, settings),
      /no delivery address/,
    );
  });
});
