/**
 * Adds the starter ingredients, recipes, group kinds and extra topping
 * prices to a database that already has the seeded menu. Safe to re-run.
 * Run: npx tsx --env-file=.env.local scripts/seed-inventory.ts
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../src/db/schema";
import { seedInventory } from "../src/db/seed-inventory";
import { databaseUrl } from "../src/db/url";

const db = drizzle(neon(databaseUrl()), { schema });

seedInventory(db).then(
  (added) => {
    console.log(`Added ${added.ingredients} ingredients and ${added.recipeLines} recipe lines.`);
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
