/**
 * Replaces the menu and recipe book with Emiliano's Pizzeria's Toast menu.
 * Run: npx tsx --env-file=.env.local scripts/import-emilianos-menu.ts
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../src/db/schema";
import { importEmilianosMenu } from "../src/db/emilianos-menu";
import { databaseUrl } from "../src/db/url";

const db = drizzle(neon(databaseUrl()), { schema });

importEmilianosMenu(db).then(
  (s) => {
    console.log(
      `Imported ${s.items} items (${s.soldOut} sold out) in ${s.categories} categories, ` +
        `${s.groups} modifier groups with ${s.modifiers} modifiers, ` +
        `${s.ingredients} ingredients and ${s.recipeLines} recipe lines, and the "${s.promotion}" promotion.`,
    );
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
