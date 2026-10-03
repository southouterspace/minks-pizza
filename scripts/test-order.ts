import { createOrder } from "../src/lib/checkout";
import { OrderError } from "../src/lib/orders";
import { db, menuItems, modifiers, modifierGroups } from "../src/db";
import { eq } from "drizzle-orm";

async function main() {
  const [cheese] = await db.select().from(menuItems).where(eq(menuItems.name, "Cheese Pizza"));
  const groups = await db.select().from(modifierGroups);
  const mods = await db.select().from(modifiers);
  const groupByName = Object.fromEntries(groups.map(g => [g.name, g]));
  const pick = (groupName: string, modName: string) =>
    mods.find(m => m.groupId === groupByName[groupName].id && m.name === modName)!.id;

  // Valid order: Large cheese, thin crust, pepperoni + mushrooms
  const order = await createOrder({
    orderType: "pickup",
    customerName: "Test Customer",
    customerPhone: "(555) 010-9999",
    customerEmail: "test@example.com",
    tipCents: 300,
    lines: [{
      itemId: cheese.id,
      quantity: 2,
      modifierIds: [pick("Size", 'Large 14"'), pick("Crust", "Thin Crust"), pick("Extra Toppings", "Pepperoni"), pick("Extra Toppings", "Mushrooms")],
      notes: "extra crispy",
    }],
  });
  // Expected: (1099 + 600 + 0 + 175 + 150) * 2 = 2024*2 = 4048 subtotal, tax 0 (OR), +300 tip = 4348
  console.log("order #", order.orderNumber, "subtotal", order.subtotalCents, "total", order.totalCents, "status", order.status, "payment", order.paymentStatus);
  if (order.subtotalCents !== 4048 || order.totalCents !== 4348) throw new Error("PRICE MISMATCH");

  // Invalid: missing required Size
  try {
    await createOrder({
      orderType: "pickup", customerName: "X", customerPhone: "5550101111", tipCents: 0,
      lines: [{ itemId: cheese.id, quantity: 1, modifierIds: [] }],
    });
    throw new Error("SHOULD HAVE FAILED (missing size)");
  } catch (e) {
    if (e instanceof OrderError) console.log("correctly rejected missing size:", e.message);
    else throw e;
  }

  // Invalid: delivery below minimum
  try {
    await createOrder({
      orderType: "delivery", customerName: "X", customerPhone: "5550101111", tipCents: 0,
      addressLine1: "1 Main St", zip: "97205",
      lines: [{ itemId: cheese.id, quantity: 1, modifierIds: [pick("Size", 'Small 10"'), pick("Crust", "Hand Tossed")] }],
    });
    throw new Error("SHOULD HAVE FAILED (below minimum)");
  } catch (e) {
    if (e instanceof OrderError) console.log("correctly rejected below-minimum delivery:", e.message);
    else throw e;
  }
  console.log("ALL ORDER TESTS PASSED");
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
