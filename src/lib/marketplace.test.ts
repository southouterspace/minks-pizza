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
    assert.deepEqual(externalOrderRows(ORDER, new Map([[7, { station: "pizza", isAlcoholic: false }]])), {
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
        status: "held",
        taxRateBps: 874,
        paidCents: 5230,
      },
      items: [
        {
          menuItemId: 7,
          itemName: "Large Margherita",
          quantity: 2,
          unitPriceCents: 1800,
          lineTotalCents: 3600,
          modifiers: [
            { kind: "option", modifierId: null, role: "option", groupName: "Crust", modifierName: "Thin", priceDeltaCents: 0 },
          ],
          notes: null,
          station: "pizza",
          isAlcoholic: false,
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
          isAlcoholic: false,
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
          isAlcoholic: false,
        },
      ],
      tender: { direction: "payment", method: "marketplace", amountCents: 5230, tipCents: 0 },
    });
  });

  it("snapshots a known item's 21+ flag onto its line", () => {
    const rows = externalOrderRows(ORDER, new Map([[7, { station: "counter", isAlcoholic: true }]]));
    assert.deepEqual(
      rows.items.map((i) => [i.itemName, i.isAlcoholic]),
      [["Large Margherita", true], ["Retired Special", false], ["Soda", false]],
    );
  });

  it("keeps the platform's tax when it is not a whole number of basis points", () => {
    const rows = externalOrderRows({ ...ORDER, subtotalCents: 3724, taxCents: 307 }, new Map());
    assert.equal(rows.order.taxCents, 307);
    assert.equal(rows.order.taxRateBps, 824);
  });
});
