/**
 * Cost and quantity entry for ingredients and recipes, checked against literal values.
 * Run: npx tsx scripts/test-unit-entry.ts
 */
import assert from "node:assert/strict";
import {
  amountIn,
  costToMillicents,
  formatUnitCost,
  readableUnit,
  unitFor,
} from "../src/lib/unit-entry";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const CASE = { name: "case", baseQtyMilli: 4 * 5 * 453_592 };

test("cost per pound and per case to millicents per gram", () => {
  assert.equal(costToMillicents(400, unitFor("lb", "g")!), 882);
  assert.equal(costToMillicents(3850, unitFor("case", "g", [CASE])!), 424);
});

test("unitFor refuses another family's unit and lets a pack win a name clash", () => {
  assert.equal(unitFor("fl oz", "g"), undefined);
  assert.equal(unitFor("case", "g"), undefined);
  assert.equal(unitFor("lb", "g", [{ name: "lb", baseQtyMilli: 1 }])!.baseQtyMilli, 1);
});

test("unit cost display", () => {
  assert.equal(formatUnitCost(882, "g"), "$4.00/lb");
  assert.equal(formatUnitCost(60_000, "each"), "$0.60/each");
  assert.equal(formatUnitCost(250_000, "each"), "$2.50/each");
  assert.equal(formatUnitCost(0, "g"), "$0.00/lb");
  assert.equal(formatUnitCost(10, "g"), "$0.0454/lb");
});

test("readable unit for stored quantities", () => {
  assert.equal(readableUnit([20 * 453_592], "g").name, "lb");
  assert.equal(readableUnit([5 * 28_350, 8 * 28_350], "g").name, "oz");
  assert.equal(readableUnit([7_088], "g").name, "oz");
  assert.equal(readableUnit([3_000], "g").name, "g");
  assert.equal(readableUnit([], "ml").name, "fl oz");
  assert.equal(readableUnit([2_000], "each").name, "each");
});

test("amountIn prefills inputs", () => {
  assert.equal(amountIn(226_800, unitFor("oz", "g")!), "8");
  assert.equal(amountIn(-28_350, unitFor("oz", "g")!), "-1");
  assert.equal(amountIn(7_088, unitFor("oz", "g")!), "0.25");
});

console.log(`\n${passed} passed`);
