import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { externalOrderRows, type ExternalOrder } from "./marketplace";

const ORDER: ExternalOrder = {
  source: "doordash",
  sourceOrderId: "dd-order-9f2",
  sourceDisplayId: "A1B2C",
  orderType: "delivery",
  customerName: "Grace H.",
  customerPhone: "+15550001111",
  addressLine1: null,
  addressLine2: null,
  city: null,
  zip: null,
  notes: "Extra napkins",
  lines: [
    {
      merchantItemId: 7,
      name: "Large Margherita",
      quantity: 2,
      unitPriceCents: 1800,
      modifiers: [{ groupName: "Crust", modifierName: "Thin", priceDeltaCents: 0 }],
      notes: null,
    },
    { merchantItemId: 999, name: "Retired Special", quantity: 1, unitPriceCents: 500, modifiers: [], notes: "well done" },
    { merchantItemId: null, name: "Soda", quantity: 1, unitPriceCents: 250, modifiers: [], notes: null },
  ],
  subtotalCents: 4350,
  taxCents: 380,
  deliveryFeeCents: 0,
  tipCents: 500,
  totalCents: 5230,
};

describe("externalOrderRows", () => {
  it("maps a marketplace order onto our rows", () => {
    assert.deepEqual(externalOrderRows(ORDER, new Map([[7, "pizza"]])), {
      order: {
        source: "doordash",
        sourceOrderId: "dd-order-9f2",
        sourceDisplayId: "A1B2C",
        orderType: "delivery",
        customerName: "Grace H.",
        customerPhone: "+15550001111",
        addressLine1: null,
        addressLine2: null,
        city: null,
        zip: null,
        orderNotes: "Extra napkins",
        subtotalCents: 4350,
        taxCents: 380,
        deliveryFeeCents: 0,
        tipCents: 500,
        totalCents: 5230,
        paymentStatus: "paid",
      },
      items: [
        {
          menuItemId: 7,
          itemName: "Large Margherita",
          quantity: 2,
          unitPriceCents: 1800,
          lineTotalCents: 3600,
          modifiers: [{ groupName: "Crust", modifierName: "Thin", priceDeltaCents: 0 }],
          notes: null,
          station: "pizza",
        },
        {
          menuItemId: null,
          itemName: "Retired Special",
          quantity: 1,
          unitPriceCents: 500,
          lineTotalCents: 500,
          modifiers: [],
          notes: "well done",
          station: "kitchen",
        },
        {
          menuItemId: null,
          itemName: "Soda",
          quantity: 1,
          unitPriceCents: 250,
          lineTotalCents: 250,
          modifiers: [],
          notes: null,
          station: "kitchen",
        },
      ],
    });
  });
});
