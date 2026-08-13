/**
 * Seeds the database with the singleton store settings row and a starter
 * pizzeria menu the operator can edit or replace from the admin dashboard.
 *
 * Run with: npm run db:seed  (idempotent — skips if categories already exist)
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";
import { databaseUrl } from "./url";

const sql = neon(databaseUrl());
const db = drizzle(sql, { schema });

async function main() {
  // Singleton settings row (unpublished until the operator flips the switch).
  await db
    .insert(schema.storeSettings)
    .values({
      id: 1,
      name: "Mink's Pizza",
      tagline: "Hand-tossed. Wood-fired. Neighborhood favorite.",
      phone: "(555) 010-7429",
      addressLine1: "412 Elm Street",
      city: "Portland",
      state: "OR",
      zip: "97205",
      hours: [
        { day: 0, open: "12:00", close: "21:00", closed: false },
        { day: 1, open: "11:00", close: "21:00", closed: true },
        { day: 2, open: "11:00", close: "21:00", closed: false },
        { day: 3, open: "11:00", close: "21:00", closed: false },
        { day: 4, open: "11:00", close: "22:00", closed: false },
        { day: 5, open: "11:00", close: "23:00", closed: false },
        { day: 6, open: "12:00", close: "23:00", closed: false },
      ],
      pickupEnabled: true,
      deliveryEnabled: true,
      pickupPrepMinutes: 20,
      deliveryPrepMinutes: 45,
      deliveryFeeCents: 399,
      deliveryMinimumCents: 1500,
      taxRateBps: 0, // Oregon — no sales tax; operator can change
      isPublished: false,
      isAcceptingOrders: true,
    })
    .onConflictDoNothing();

  const existing = await db.select().from(schema.categories);
  if (existing.length > 0) {
    console.log("Menu already seeded — skipping.");
    return;
  }

  // --- Modifier groups -----------------------------------------------------
  const [sizeGroup] = await db
    .insert(schema.modifierGroups)
    .values({ name: "Size", minSelect: 1, maxSelect: 1, sortOrder: 0 })
    .returning();
  const [crustGroup] = await db
    .insert(schema.modifierGroups)
    .values({ name: "Crust", minSelect: 1, maxSelect: 1, sortOrder: 1 })
    .returning();
  const [toppingsGroup] = await db
    .insert(schema.modifierGroups)
    .values({ name: "Extra Toppings", minSelect: 0, maxSelect: null, sortOrder: 2 })
    .returning();
  const [wingSauceGroup] = await db
    .insert(schema.modifierGroups)
    .values({ name: "Sauce", minSelect: 1, maxSelect: 1, sortOrder: 0 })
    .returning();
  const [dressingGroup] = await db
    .insert(schema.modifierGroups)
    .values({ name: "Dressing", minSelect: 1, maxSelect: 1, sortOrder: 0 })
    .returning();

  await db.insert(schema.modifiers).values([
    { groupId: sizeGroup.id, name: 'Small 10"', priceDeltaCents: 0, isDefault: false, sortOrder: 0 },
    { groupId: sizeGroup.id, name: 'Medium 12"', priceDeltaCents: 300, isDefault: true, sortOrder: 1 },
    { groupId: sizeGroup.id, name: 'Large 14"', priceDeltaCents: 600, isDefault: false, sortOrder: 2 },
    { groupId: sizeGroup.id, name: 'X-Large 16"', priceDeltaCents: 900, isDefault: false, sortOrder: 3 },

    { groupId: crustGroup.id, name: "Hand Tossed", priceDeltaCents: 0, isDefault: true, sortOrder: 0 },
    { groupId: crustGroup.id, name: "Thin Crust", priceDeltaCents: 0, sortOrder: 1 },
    { groupId: crustGroup.id, name: "Deep Dish", priceDeltaCents: 200, sortOrder: 2 },
    { groupId: crustGroup.id, name: "Gluten-Free", priceDeltaCents: 300, sortOrder: 3 },

    { groupId: toppingsGroup.id, name: "Pepperoni", priceDeltaCents: 175, sortOrder: 0 },
    { groupId: toppingsGroup.id, name: "Italian Sausage", priceDeltaCents: 175, sortOrder: 1 },
    { groupId: toppingsGroup.id, name: "Bacon", priceDeltaCents: 200, sortOrder: 2 },
    { groupId: toppingsGroup.id, name: "Mushrooms", priceDeltaCents: 150, sortOrder: 3 },
    { groupId: toppingsGroup.id, name: "Red Onions", priceDeltaCents: 125, sortOrder: 4 },
    { groupId: toppingsGroup.id, name: "Green Peppers", priceDeltaCents: 125, sortOrder: 5 },
    { groupId: toppingsGroup.id, name: "Black Olives", priceDeltaCents: 150, sortOrder: 6 },
    { groupId: toppingsGroup.id, name: "Fresh Basil", priceDeltaCents: 125, sortOrder: 7 },
    { groupId: toppingsGroup.id, name: "Extra Cheese", priceDeltaCents: 200, sortOrder: 8 },
    { groupId: toppingsGroup.id, name: "Pineapple", priceDeltaCents: 150, sortOrder: 9 },

    { groupId: wingSauceGroup.id, name: "Buffalo", priceDeltaCents: 0, isDefault: true, sortOrder: 0 },
    { groupId: wingSauceGroup.id, name: "BBQ", priceDeltaCents: 0, sortOrder: 1 },
    { groupId: wingSauceGroup.id, name: "Garlic Parmesan", priceDeltaCents: 50, sortOrder: 2 },

    { groupId: dressingGroup.id, name: "Ranch", priceDeltaCents: 0, isDefault: true, sortOrder: 0 },
    { groupId: dressingGroup.id, name: "Caesar", priceDeltaCents: 0, sortOrder: 1 },
    { groupId: dressingGroup.id, name: "Balsamic Vinaigrette", priceDeltaCents: 0, sortOrder: 2 },
  ]);

  // --- Categories & items --------------------------------------------------
  const [specialty] = await db
    .insert(schema.categories)
    .values({ name: "Specialty Pizzas", description: "House favorites, ready to go", sortOrder: 0 })
    .returning();
  const [byo] = await db
    .insert(schema.categories)
    .values({ name: "Build Your Own", description: "Start with cheese, make it yours", sortOrder: 1 })
    .returning();
  const [sides] = await db
    .insert(schema.categories)
    .values({ name: "Sides & Salads", sortOrder: 2 })
    .returning();
  const [drinks] = await db
    .insert(schema.categories)
    .values({ name: "Drinks", sortOrder: 3 })
    .returning();

  const items = await db
    .insert(schema.menuItems)
    .values([
      { categoryId: specialty.id, name: "Margherita", description: "San Marzano tomato, fresh mozzarella, basil, olive oil", basePriceCents: 1299, isFeatured: true, sortOrder: 0 },
      { categoryId: specialty.id, name: "Pepperoni Classic", description: "Double pepperoni, mozzarella, house red sauce", basePriceCents: 1399, isFeatured: true, sortOrder: 1 },
      { categoryId: specialty.id, name: "Meat Lovers", description: "Pepperoni, sausage, bacon, ham", basePriceCents: 1599, sortOrder: 2 },
      { categoryId: specialty.id, name: "Veggie Supreme", description: "Mushrooms, peppers, onions, olives, tomatoes", basePriceCents: 1499, sortOrder: 3 },
      { categoryId: specialty.id, name: "BBQ Chicken", description: "Grilled chicken, red onion, BBQ swirl, cilantro", basePriceCents: 1549, sortOrder: 4 },
      { categoryId: byo.id, name: "Cheese Pizza", description: "House red sauce and mozzarella — add your favorite toppings", basePriceCents: 1099, isFeatured: true, sortOrder: 0 },
      { categoryId: sides.id, name: "Garlic Knots (6)", description: "Brushed with garlic butter, side of marinara", basePriceCents: 599, sortOrder: 0 },
      { categoryId: sides.id, name: "Chicken Wings (8)", description: "Choose your sauce", basePriceCents: 999, sortOrder: 1 },
      { categoryId: sides.id, name: "Caesar Salad", description: "Romaine, parmesan, croutons", basePriceCents: 849, sortOrder: 2 },
      { categoryId: sides.id, name: "House Salad", description: "Mixed greens, tomato, cucumber, red onion", basePriceCents: 799, sortOrder: 3 },
      { categoryId: drinks.id, name: "Soda (2-Liter)", description: "Coke, Diet Coke, Sprite, or Root Beer", basePriceCents: 399, sortOrder: 0 },
      { categoryId: drinks.id, name: "Sparkling Water", basePriceCents: 249, sortOrder: 1 },
    ])
    .returning();

  const byName = Object.fromEntries(items.map((i) => [i.name, i]));

  const pizzaGroups = (itemId: number) => [
    { itemId, groupId: sizeGroup.id, sortOrder: 0 },
    { itemId, groupId: crustGroup.id, sortOrder: 1 },
    { itemId, groupId: toppingsGroup.id, sortOrder: 2 },
  ];

  await db.insert(schema.itemModifierGroups).values([
    ...pizzaGroups(byName["Margherita"].id),
    ...pizzaGroups(byName["Pepperoni Classic"].id),
    ...pizzaGroups(byName["Meat Lovers"].id),
    ...pizzaGroups(byName["Veggie Supreme"].id),
    ...pizzaGroups(byName["BBQ Chicken"].id),
    ...pizzaGroups(byName["Cheese Pizza"].id),
    { itemId: byName["Chicken Wings (8)"].id, groupId: wingSauceGroup.id, sortOrder: 0 },
    { itemId: byName["Caesar Salad"].id, groupId: dressingGroup.id, sortOrder: 0 },
    { itemId: byName["House Salad"].id, groupId: dressingGroup.id, sortOrder: 0 },
  ]);

  console.log("Seeded store settings + starter menu.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
