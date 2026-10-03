/**
 * Order lifecycle rules, checked against literal expectations.
 * Run: npx tsx scripts/test-order-workflow.ts
 */
import assert from "node:assert/strict";
import {
  canTransition,
  describeEvent,
  isActive,
  isCooking,
  isLate,
  minutesUntil,
  ORDER_STATUSES,
  statusTimestamps,
  TRANSITIONS,
  type OrderStatus,
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
    held: ["new", "canceled"],
    new: ["preparing", "ready", "canceled"],
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
    "held->new",
    "held->canceled",
    "new->preparing",
    "new->ready",
    "new->canceled",
    "preparing->ready",
    "preparing->canceled",
    "ready->completed",
    "ready->canceled",
  ]);
});

test("no skipping ahead or going back", () => {
  assert.equal(canTransition("held", "ready"), false);
  assert.equal(canTransition("new", "completed"), false);
  assert.equal(canTransition("ready", "preparing"), false);
  assert.equal(canTransition("completed", "canceled"), false);
  assert.equal(canTransition("canceled", "new"), false);
});

test("isLate: cooking orders past their promise", () => {
  assert.equal(isLate(at("2026-10-03T23:29:00Z"), "held", now), true);
  assert.equal(isLate(at("2026-10-03T23:29:00Z"), "new", now), true);
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
  assert.deepEqual(statusTimestamps("held", now), {});
  assert.deepEqual(statusTimestamps("new", now), { readyAt: null, completedAt: null });
  assert.deepEqual(statusTimestamps("preparing", now), { readyAt: null, completedAt: null });
  assert.deepEqual(statusTimestamps("ready", now), { readyAt: at("2026-10-03T23:30:00.000Z") });
  assert.deepEqual(statusTimestamps("completed", now), {
    completedAt: at("2026-10-03T23:30:00.000Z"),
  });
  assert.deepEqual(statusTimestamps("canceled", now), {
    canceledAt: at("2026-10-03T23:30:00.000Z"),
  });
});

test("active and cooking statuses", () => {
  assert.deepEqual(ORDER_STATUSES.filter(isActive), ["held", "new", "preparing", "ready"]);
  assert.deepEqual(ORDER_STATUSES.filter(isCooking), ["held", "new", "preparing"]);
});

test("describeEvent headlines", () => {
  const status = (fromStatus: OrderStatus | null, toStatus: OrderStatus | null) =>
    describeEvent({ type: "status_changed", fromStatus, toStatus });
  assert.equal(describeEvent({ type: "placed", fromStatus: null, toStatus: null }), "Order placed");
  assert.equal(status("held", "new"), "Sent to kitchen");
  assert.equal(status("ready", "new"), "More food fired");
  assert.equal(status("preparing", "canceled"), "Canceled");
  assert.equal(status("ready", "preparing"), "Recalled to the kitchen");
  assert.equal(status("completed", "preparing"), "Recalled to the kitchen");
  assert.equal(status("new", "preparing"), "Preparing");
  assert.equal(status("preparing", "ready"), "Ready");
  assert.equal(status(null, null), "Status changed");
  assert.equal(describeEvent({ type: "eta_changed", fromStatus: null, toStatus: null }), "Promised time pushed");
});

console.log(`\n${passed} passed`);
