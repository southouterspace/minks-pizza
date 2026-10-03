/**
 * Order lifecycle rules, checked against literal expectations.
 * Run: npx tsx scripts/test-order-workflow.ts
 */
import assert from "node:assert/strict";
import {
  canTransition,
  isLate,
  minutesUntil,
  ORDER_STATUSES,
  statusTimestamps,
  TRANSITIONS,
} from "../src/lib/order-workflow";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const now = new Date("2026-10-03T23:30:00.000Z");
const at = (iso: string) => new Date(iso);

test("transition table matches the lifecycle", () => {
  assert.deepEqual(TRANSITIONS, {
    new: ["confirmed", "canceled"],
    confirmed: ["preparing", "canceled"],
    preparing: ["ready", "canceled"],
    ready: ["completed", "canceled"],
    completed: [],
    canceled: [],
  });
});

test("every legal move, and nothing else", () => {
  const legal = ORDER_STATUSES.flatMap((from) =>
    ORDER_STATUSES.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`),
  );
  assert.deepEqual(legal, [
    "new->confirmed",
    "new->canceled",
    "confirmed->preparing",
    "confirmed->canceled",
    "preparing->ready",
    "preparing->canceled",
    "ready->completed",
    "ready->canceled",
  ]);
});

test("no skipping ahead or going back", () => {
  assert.equal(canTransition("new", "ready"), false);
  assert.equal(canTransition("ready", "preparing"), false);
  assert.equal(canTransition("completed", "canceled"), false);
  assert.equal(canTransition("canceled", "new"), false);
});

test("isLate: cooking orders past their promise", () => {
  assert.equal(isLate(at("2026-10-03T23:29:00Z"), "new", now), true);
  assert.equal(isLate(at("2026-10-03T23:29:00Z"), "confirmed", now), true);
  assert.equal(isLate(at("2026-10-03T23:29:00Z"), "preparing", now), true);
});

test("isLate: not before the promise, not once the food is ready", () => {
  assert.equal(isLate(at("2026-10-03T23:30:00Z"), "preparing", now), false);
  assert.equal(isLate(at("2026-10-03T23:45:00Z"), "new", now), false);
  assert.equal(isLate(at("2026-10-03T23:00:00Z"), "ready", now), false);
  assert.equal(isLate(at("2026-10-03T23:00:00Z"), "completed", now), false);
  assert.equal(isLate(at("2026-10-03T23:00:00Z"), "canceled", now), false);
  assert.equal(isLate(null, "new", now), false);
});

test("minutesUntil rounds and goes negative", () => {
  assert.equal(minutesUntil(at("2026-10-03T23:45:00Z"), now), 15);
  assert.equal(minutesUntil(at("2026-10-03T23:30:40Z"), now), 1);
  assert.equal(minutesUntil(at("2026-10-03T23:22:00Z"), now), -8);
});

test("statusTimestamps per destination", () => {
  assert.deepEqual(statusTimestamps("new", now), {});
  assert.deepEqual(statusTimestamps("confirmed", now), {});
  assert.deepEqual(statusTimestamps("preparing", now), { readyAt: null, completedAt: null });
  assert.deepEqual(statusTimestamps("ready", now), { readyAt: at("2026-10-03T23:30:00.000Z") });
  assert.deepEqual(statusTimestamps("completed", now), {
    completedAt: at("2026-10-03T23:30:00.000Z"),
  });
  assert.deepEqual(statusTimestamps("canceled", now), {
    canceledAt: at("2026-10-03T23:30:00.000Z"),
  });
});

console.log(`\n${passed} passed`);
