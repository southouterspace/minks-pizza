import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TIERS,
  activePromotion,
  birthdayGrantDue,
  earnPoints,
  expiryDue,
  formatMultiplier,
  formatPhone,
  normalizePhone,
  pointsSafeUntil,
  rewardDiscount,
  tierFor,
  tierProgress,
  tiersSchema,
  rewardPrice,
  repriceReward,
  type PromotionRule,
} from "./loyalty";

const TZ = "America/Chicago";

describe("normalizePhone", () => {
  it("keeps ten digits from any punctuation", () => {
    assert.equal(normalizePhone("(555) 010-2222"), "5550102222");
  });
  it("drops a leading US country code", () => {
    assert.equal(normalizePhone("+1 555.010.2222"), "5550102222");
  });
  it("rejects anything else", () => {
    assert.equal(normalizePhone("010-2222"), null);
    assert.equal(normalizePhone("25550102222"), null);
  });
  it("formats for display", () => {
    assert.equal(formatPhone("5550102222"), "(555) 010-2222");
  });
});

describe("earnPoints", () => {
  it("earns 10 points per dollar at base rate", () => {
    assert.equal(
      earnPoints({ netCents: 2448, pointsPerDollar: 10, tierMultiplierBps: 10_000, promoMultiplierBps: 10_000 }),
      244,
    );
  });
  it("stacks tier and promo multipliers and floors once", () => {
    // 2448 * 10 / 100 = 244.8, * 1.25 = 306, * 2 = 612
    assert.equal(
      earnPoints({ netCents: 2448, pointsPerDollar: 10, tierMultiplierBps: 12_500, promoMultiplierBps: 20_000 }),
      612,
    );
  });
  it("earns nothing on a fully discounted order", () => {
    assert.equal(
      earnPoints({ netCents: 0, pointsPerDollar: 10, tierMultiplierBps: 10_000, promoMultiplierBps: 10_000 }),
      0,
    );
  });
});

describe("tiers", () => {
  it("picks the highest tier reached", () => {
    assert.equal(tierFor(0, DEFAULT_TIERS).name, "Regular");
    assert.equal(tierFor(3999, DEFAULT_TIERS).name, "Regular");
    assert.equal(tierFor(4000, DEFAULT_TIERS).name, "Gold Crust");
  });
  it("reports progress toward the next tier", () => {
    assert.deepEqual(tierProgress(1000, DEFAULT_TIERS), {
      tier: { name: "Regular", minPoints: 0, multiplierBps: 10_000 },
      next: { name: "Gold Crust", minPoints: 4000, multiplierBps: 12_000 },
      pointsToNext: 3000,
      fraction: 0.25,
    });
  });
  it("has nothing left to reach at the top tier", () => {
    const p = tierProgress(5000, DEFAULT_TIERS);
    assert.equal(p.tier.name, "Gold Crust");
    assert.equal(p.next, null);
    assert.equal(p.pointsToNext, null);
  });
  it("requires the first tier to start at zero", () => {
    const r = tiersSchema.safeParse([{ name: "Gold", minPoints: 100, multiplierBps: 10_000 }]);
    assert.equal(r.success, false);
    assert.equal(r.error?.issues[0].message, "The first tier must start at 0 points");
  });
  it("formats multipliers", () => {
    assert.equal(formatMultiplier(20_000), "2x");
    assert.equal(formatMultiplier(12_500), "1.25x");
  });
});

describe("activePromotion", () => {
  const promo = (p: Partial<PromotionRule>): PromotionRule => ({
    name: "Promo",
    multiplierBps: 20_000,
    daysOfWeek: [],
    startsOn: null,
    endsOn: null,
    isActive: true,
    ...p,
  });
  // Tuesday 2026-10-06 01:00 UTC is still Monday evening in Chicago.
  const mondayNightLocal = new Date("2026-10-06T01:00:00Z");

  it("matches the weekday in store time, not UTC", () => {
    const tuesdays = promo({ name: "Double Tuesdays", daysOfWeek: [2] });
    const mondays = promo({ name: "Monday", daysOfWeek: [1] });
    assert.equal(activePromotion([tuesdays, mondays], mondayNightLocal, TZ)?.name, "Monday");
  });
  it("respects an inclusive date range in store time", () => {
    const p = promo({ startsOn: "2026-10-01", endsOn: "2026-10-05" });
    assert.equal(activePromotion([p], mondayNightLocal, TZ)?.name, "Promo");
    assert.equal(activePromotion([p], new Date("2026-10-06T12:00:00Z"), TZ), null);
  });
  it("picks the highest multiplier and skips inactive ones", () => {
    const winner = activePromotion(
      [
        promo({ name: "1.5x", multiplierBps: 15_000 }),
        promo({ name: "3x off", multiplierBps: 30_000, isActive: false }),
        promo({ name: "2x", multiplierBps: 20_000 }),
      ],
      mondayNightLocal,
      TZ,
    );
    assert.equal(winner?.name, "2x");
  });
});

describe("rewardDiscount", () => {
  const lines = [
    { categoryId: 1, unitPriceCents: 1899, quantity: 2 },
    { categoryId: 1, unitPriceCents: 2399, quantity: 1 },
    { categoryId: 3, unitPriceCents: 599, quantity: 1 },
  ];
  it("takes an amount off", () => {
    assert.deepEqual(rewardDiscount({ kind: "amount_off", amountOffCents: 300 }, lines), {
      ok: true,
      discountCents: 300,
    });
  });
  it("never discounts past the subtotal", () => {
    assert.deepEqual(
      rewardDiscount({ kind: "amount_off", amountOffCents: 2000 }, [
        { categoryId: 3, unitPriceCents: 599, quantity: 1 },
      ]),
      { ok: true, discountCents: 599 },
    );
  });
  it("frees the priciest matching item up to the cap", () => {
    assert.deepEqual(
      rewardDiscount({ kind: "free_item", categoryIds: [1, 2], maxValueCents: 2200 }, lines),
      { ok: true, discountCents: 2200 },
    );
    assert.deepEqual(
      rewardDiscount({ kind: "free_item", categoryIds: [3], maxValueCents: 900 }, lines),
      { ok: true, discountCents: 599 },
    );
  });
  it("reports a free item with nothing to apply it to", () => {
    assert.deepEqual(
      rewardDiscount({ kind: "free_item", categoryIds: [9], maxValueCents: 900 }, lines),
      { ok: false, reason: "no_matching_item" },
    );
  });
});

describe("birthdayGrantDue", () => {
  const now = new Date("2026-10-15T17:00:00Z");
  const member = {
    birthMonth: 10,
    birthdaySetAt: new Date("2026-08-01T00:00:00Z"),
    lastCompletedOrderAt: new Date("2026-03-01T00:00:00Z"),
  };
  it("is due in the birthday month for a recent customer", () => {
    assert.equal(birthdayGrantDue(member, now, TZ), true);
  });
  it("is not due for a birthday set this month", () => {
    assert.equal(
      birthdayGrantDue({ ...member, birthdaySetAt: new Date("2026-10-01T00:00:00Z") }, now, TZ),
      false,
    );
  });
  it("is not due outside the birthday month", () => {
    assert.equal(birthdayGrantDue({ ...member, birthMonth: 11 }, now, TZ), false);
  });
  it("is not due without a completed order in the past year", () => {
    assert.equal(birthdayGrantDue({ ...member, lastCompletedOrderAt: null }, now, TZ), false);
    assert.equal(
      birthdayGrantDue({ ...member, lastCompletedOrderAt: new Date("2025-10-01T00:00:00Z") }, now, TZ),
      false,
    );
  });
});

describe("expiryDue", () => {
  const now = new Date("2026-10-15T00:00:00Z");
  it("expires a balance after the inactivity window", () => {
    assert.equal(expiryDue({ pointsBalance: 120, lastActivityAt: new Date("2025-10-14T00:00:00Z") }, now, 12), true);
  });
  it("keeps a balance with recent activity", () => {
    assert.equal(expiryDue({ pointsBalance: 120, lastActivityAt: new Date("2025-10-16T00:00:00Z") }, now, 12), false);
  });
  it("tells the member the date their points are safe until", () => {
    assert.deepEqual(
      pointsSafeUntil({ pointsBalance: 120, lastActivityAt: new Date("2026-03-15T18:00:00Z") }, 12),
      new Date("2027-03-15T18:00:00Z"),
    );
    assert.equal(pointsSafeUntil({ pointsBalance: 120, lastActivityAt: new Date("2026-03-15T18:00:00Z") }, null), null);
  });
  it("never expires when the program says never, or with nothing to expire", () => {
    assert.equal(expiryDue({ pointsBalance: 120, lastActivityAt: new Date("2020-01-01T00:00:00Z") }, now, null), false);
    assert.equal(expiryDue({ pointsBalance: 0, lastActivityAt: new Date("2020-01-01T00:00:00Z") }, now, 12), false);
  });
});

describe("price protection", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const unprotected = { pointsCost: 300, previousPointsCost: null, priceProtectedUntil: null };

  it("keeps the old price for 60 days after a raise", () => {
    const raised = repriceReward(unprotected, 400, now);
    assert.deepEqual(raised, {
      pointsCost: 400,
      previousPointsCost: 300,
      priceProtectedUntil: new Date("2026-11-30T12:00:00Z"),
    });
    assert.deepEqual(rewardPrice(raised, now), {
      cost: 300,
      increase: { cost: 400, on: new Date("2026-11-30T12:00:00Z") },
    });
  });
  it("charges the new price once protection ends", () => {
    const raised = repriceReward(unprotected, 400, now);
    assert.deepEqual(rewardPrice(raised, new Date("2026-11-30T12:00:01Z")), { cost: 400, increase: null });
  });
  it("applies a cut immediately", () => {
    const raised = repriceReward(unprotected, 400, now);
    assert.deepEqual(repriceReward(raised, 250, now), {
      pointsCost: 250,
      previousPointsCost: null,
      priceProtectedUntil: null,
    });
  });
  it("protects from today's price when raising again during protection", () => {
    const raised = repriceReward(unprotected, 400, now);
    const again = repriceReward(raised, 500, new Date("2026-10-11T12:00:00Z"));
    assert.equal(again.previousPointsCost, 300);
    assert.equal(rewardPrice(again, new Date("2026-10-11T12:00:00Z")).cost, 300);
  });
});
