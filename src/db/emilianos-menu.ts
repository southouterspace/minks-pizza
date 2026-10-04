/**
 * Emiliano's Pizzeria menu, imported from their Toast storefront
 * (emilianospizzeria.toast.site/menu) on 2026-10-03, sold-out items included.
 *
 * Toast sells each pizza size as its own item ("12in Hawaiian", "14in
 * Hawaiian", ...). Here each pie is one item priced at its 12in price, with
 * one shared Size group stepping +$2 / +$4 / +$6 (Toast's cheese pizza steps,
 * applied to every pie) and one shared placeable Toppings group in place of
 * Toast's nested Whole / Left / Right groups. Recipes are written per size.
 *
 * Toast has no portions or costs: recipe quantities and ingredient costs
 * below are estimates for the operator to correct in Inventory.
 */
import { eq, inArray, notInArray } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { GroupRole } from "../lib/pricing";
import type { KitchenStation } from "../lib/kds";
import { promotionRewardSchema } from "../lib/promotion-schema";
import type { BaseUnit } from "../lib/units";
import * as schema from "./schema";

type Db = NeonHttpDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Ingredients
// ---------------------------------------------------------------------------

const LB = 453.592;
const OZ = 28.3495;

type Ingredient = { name: string; unit: BaseUnit; area: string; perLb?: number; each?: number };

const INGREDIENTS: Ingredient[] = [
  { name: "Dough ball 12in", unit: "each", area: "Walk-in", each: 0.45 },
  { name: "Dough ball 14in", unit: "each", area: "Walk-in", each: 0.6 },
  { name: "Dough ball 16in", unit: "each", area: "Walk-in", each: 0.8 },
  { name: "Dough ball 18in", unit: "each", area: "Walk-in", each: 1.0 },
  { name: "Gluten-free crust 12in", unit: "each", area: "Freezer", each: 2.5 },
  { name: "Red sauce", unit: "g", area: "Walk-in", perLb: 1.2 },
  { name: "Alfredo sauce", unit: "g", area: "Walk-in", perLb: 3.0 },
  { name: "BBQ sauce", unit: "g", area: "Make line", perLb: 2.0 },
  { name: "Buffalo sauce", unit: "g", area: "Make line", perLb: 2.5 },
  { name: "Garlic & basil olive oil", unit: "g", area: "Make line", perLb: 6.0 },
  { name: "Texas hot honey", unit: "g", area: "Make line", perLb: 5.0 },
  { name: "Garlic butter", unit: "g", area: "Walk-in", perLb: 4.0 },
  { name: "Mozzarella", unit: "g", area: "Walk-in", perLb: 4.0 },
  { name: "Cheddar", unit: "g", area: "Walk-in", perLb: 4.0 },
  { name: "Feta", unit: "g", area: "Walk-in", perLb: 5.0 },
  { name: "Ricotta", unit: "g", area: "Walk-in", perLb: 3.0 },
  { name: "Pecorino Romano", unit: "g", area: "Walk-in", perLb: 9.0 },
  { name: "Pepperoni", unit: "g", area: "Walk-in", perLb: 5.5 },
  { name: "Italian sausage", unit: "g", area: "Walk-in", perLb: 4.5 },
  { name: "Bacon", unit: "g", area: "Walk-in", perLb: 6.0 },
  { name: "Ham", unit: "g", area: "Walk-in", perLb: 4.0 },
  { name: "Chicken", unit: "g", area: "Walk-in", perLb: 5.0 },
  { name: "Hamburger beef", unit: "g", area: "Walk-in", perLb: 4.5 },
  { name: "Brisket", unit: "g", area: "Walk-in", perLb: 9.0 },
  { name: "Bell pepper", unit: "g", area: "Make line", perLb: 1.6 },
  { name: "Red onion", unit: "g", area: "Make line", perLb: 1.0 },
  { name: "Black olives", unit: "g", area: "Make line", perLb: 3.5 },
  { name: "Mushrooms", unit: "g", area: "Make line", perLb: 3.0 },
  { name: "Tomato", unit: "g", area: "Make line", perLb: 1.8 },
  { name: "Spinach", unit: "g", area: "Make line", perLb: 4.0 },
  { name: "Jalapeño", unit: "g", area: "Make line", perLb: 2.0 },
  { name: "Pineapple", unit: "g", area: "Make line", perLb: 1.5 },
  { name: "Fresh basil", unit: "g", area: "Make line", perLb: 12.0 },
  { name: "Fresh garlic", unit: "g", area: "Make line", perLb: 4.0 },
  { name: "Red pepper flakes", unit: "g", area: "Dry storage", perLb: 8.0 },
  { name: "Pepperoncini", unit: "g", area: "Make line", perLb: 3.0 },
  { name: "Lettuce", unit: "g", area: "Walk-in", perLb: 1.5 },
  { name: "Croutons", unit: "g", area: "Dry storage", perLb: 4.0 },
  { name: "Ranch dressing", unit: "g", area: "Walk-in", perLb: 3.0 },
  { name: "Caesar dressing", unit: "g", area: "Walk-in", perLb: 3.5 },
  { name: "Italian dressing", unit: "g", area: "Walk-in", perLb: 3.0 },
  { name: "Greek vinaigrette", unit: "g", area: "Walk-in", perLb: 3.5 },
  { name: "Jumbo chicken wing", unit: "each", area: "Freezer", each: 0.55 },
  { name: "Pepsi 20oz", unit: "each", area: "Cooler", each: 1.1 },
  { name: "Pepsi Zero Sugar 20oz", unit: "each", area: "Cooler", each: 1.1 },
  { name: "Starry 20oz", unit: "each", area: "Cooler", each: 1.1 },
  { name: "Gatorade 20oz", unit: "each", area: "Cooler", each: 1.2 },
  { name: "Pepsi 2L", unit: "each", area: "Cooler", each: 1.8 },
  { name: "Pepsi Zero 2L", unit: "each", area: "Cooler", each: 1.8 },
  { name: "Starry 2L", unit: "each", area: "Cooler", each: 1.8 },
  { name: "Cheesecake slice", unit: "each", area: "Walk-in", each: 1.75 },
  { name: "Chocolate mousse cake slice", unit: "each", area: "Walk-in", each: 2.25 },
  { name: "Cannoli", unit: "each", area: "Walk-in", each: 1.5 },
  { name: "Tiramisu slice", unit: "each", area: "Walk-in", each: 2.25 },
  { name: "Lemoncello cake slice", unit: "each", area: "Walk-in", each: 2.25 },
];

/** Millicents per base unit: per gram for weighed goods, per piece otherwise. */
function unitCost(i: Ingredient): number {
  return i.each !== undefined ? Math.round(i.each * 100_000) : Math.round(((i.perLb ?? 0) * 100_000) / LB);
}

/** [ingredient, quantity] where quantity is ounces for weighed goods and pieces otherwise. */
type Use = readonly [string, number];

// ---------------------------------------------------------------------------
// Modifier groups
// ---------------------------------------------------------------------------

type Option = {
  name: string;
  cents?: number;
  isDefault?: true;
  available?: boolean;
  /** Set on Size options: the pie size the option makes. */
  size?: Size;
  /** Usage regardless of size. */
  recipe?: Use[];
  /** Usage on a sized pie, one line per Size option. */
  sized?: (size: Size) => Use[];
};
type Group = { name: string; role: GroupRole; min: number; max: number | null; options: Option[] };

const opts = (names: string[], cents = 0): Option[] => names.map((name) => ({ name, cents }));

const SIZES = ["12in", "14in", "16in", "18in"] as const;
type Size = (typeof SIZES)[number];
const at = (size: Size, oz: readonly [number, number, number, number]) => oz[SIZES.indexOf(size)];

const MEAT = [2, 2.5, 3.5, 4.5] as const;
const VEG = [1.5, 2, 2.5, 3.5] as const;
const SAUCE = [4, 5, 6, 8] as const;
const CHEESE = [6, 8, 10, 13] as const;
const SOFT_CHEESE = [1.5, 2, 2.5, 3.5] as const;
const PINCH = [0.15, 0.2, 0.25, 0.3] as const;
const OIL = [1, 1.25, 1.5, 2] as const;
const HONEY = [0.75, 1, 1.25, 1.5] as const;

/** Toast's whole-pie topping list, the same at every size. */
const TOPPINGS: [string, string, readonly [number, number, number, number]][] = [
  ["Bacon", "Bacon", MEAT],
  ["Bell Pepper", "Bell pepper", VEG],
  ["Black Olives", "Black olives", VEG],
  ["Chicken", "Chicken", MEAT],
  ["Extra Cheese", "Mozzarella", [2, 3, 4, 5]],
  ["Feta", "Feta", SOFT_CHEESE],
  ["Fresh Mushroom", "Mushrooms", VEG],
  ["Fresh Basil", "Fresh basil", PINCH],
  ["Fresh Garlic", "Fresh garlic", [0.25, 0.3, 0.4, 0.5]],
  ["Ham", "Ham", MEAT],
  ["Hamburger Beef", "Hamburger beef", MEAT],
  ["Italian Sausage", "Italian sausage", MEAT],
  ["Jalapeño", "Jalapeño", VEG],
  ["Pepperoni", "Pepperoni", MEAT],
  ["Pineapple", "Pineapple", VEG],
  ["Red Onion", "Red onion", VEG],
  ["Ricotta", "Ricotta", SOFT_CHEESE],
  ["Spinach", "Spinach", VEG],
  ["Texas Hot Honey", "Texas hot honey", HONEY],
  ["Tomato", "Tomato", VEG],
];

/**
 * One price at every size. Toast charges $2.00 / $2.25 / $2.50 / $3.50 a
 * topping on a 12 / 14 / 16 / 18in pie (twice its listed half price); Mink's
 * prices a topping once, so it takes the 12in price the pies start at.
 */
const TOPPING_CENTS = 200;

const SAUCES: [string, string | null, readonly [number, number, number, number]][] = [
  ["Red Sauce", "Red sauce", SAUCE],
  ["Alfredo Sauce", "Alfredo sauce", SAUCE],
  ["BBQ Sauce", "BBQ sauce", SAUCE],
  ["Buffalo Sauce", "Buffalo sauce", SAUCE],
  ["Garlic & Basil Olive Oil", "Garlic & basil olive oil", OIL],
  ["No Sauce", null, SAUCE],
];

/** Free swaps for a removed ingredient, Toast's list with its abbreviations spelled out. */
const SWAPS = [
  "Bacon", "Balsamic Drizzle", "BBQ Chicken", "Bell Pepper", "Black Olives", "Buffalo Chicken", "Cheddar",
  "Extra Cheese", "Feta", "Fresh Basil", "Fresh Garlic", "Garlic & Basil Olive Oil", "Ham", "Hamburger Beef",
  "Italian Sausage", "Jalapeño", "Pepperoni", "Pineapple", "Red Onion", "Ricotta", "Salami", "Sautéed Mushroom",
  "Spinach", "Texas Hot Honey", "Tomato", "White Onion",
];

const DRESSINGS: [string, string | null][] = [
  ["Italian Dressing", "Italian dressing"],
  ["Caesar Dressing", "Caesar dressing"],
  ["Ranch Dressing", "Ranch dressing"],
  ["Greek Dressing", "Greek vinaigrette"],
  ["No Dressing", null],
];

const GROUPS = {
  size: {
    name: "Size",
    role: "size",
    min: 1,
    max: 1,
    options: (['Small 12"', 'Medium 14"', 'Large 16"', 'X-Large 18"'] as const).map((name, i) => ({
      name,
      cents: [0, 200, 400, 600][i],
      size: SIZES[i],
      ...(i === 0 ? { isDefault: true as const } : {}),
    })),
  },
  sauce: {
    name: "Sauce",
    role: "option",
    min: 0,
    max: 1,
    options: SAUCES.map(([name, ingredient, oz]) => ({
      name,
      ...(ingredient ? { recipe: [[ingredient, at("12in", oz)]], sized: (size: Size): Use[] => [[ingredient, at(size, oz)]] } : {}),
    })),
  },
  toppings: {
    name: "Toppings",
    role: "topping",
    min: 0,
    max: null,
    options: TOPPINGS.map(([name, ingredient, oz]) => ({
      name,
      cents: TOPPING_CENTS,
      // The all-sizes line covers the 12in gluten-free pie, which has no Size group.
      recipe: [[ingredient, at("12in", oz)]],
      sized: (size) => [[ingredient, at(size, oz)]],
    })),
  },
  swap: { name: "Swap a Topping (no charge)", role: "option", min: 0, max: 1, options: opts(SWAPS) },
  cookTime: { name: "Cook Time", role: "option", min: 0, max: 1, options: opts(["Light", "Well Done"]) },
  dressing: {
    name: "Dressing",
    role: "option",
    min: 1,
    max: 1,
    options: DRESSINGS.map(([name, ingredient]) => ({ name, recipe: ingredient ? [[ingredient, 2]] : [] })),
  },
  saladProtein: {
    name: "Add Protein",
    role: "option",
    min: 0,
    max: null,
    options: [{ name: "Chicken", cents: 199, recipe: [["Chicken", 3]] }],
  },
  wingFlavor: {
    name: "Wing Flavor",
    role: "option",
    min: 1,
    max: 1,
    options: opts(["Buffalo", "BBQ", "Lemon Pepper", "Hot Honey Lemon Pepper", "Plain (No Sauce)"]),
  },
  calzoneToppings: {
    name: "Calzone Toppings",
    // No halves on a calzone, so these are plain add-ons rather than placeable toppings.
    role: "option",
    min: 0,
    max: null,
    // Toast leaves calzone topping prices to the register; priced like a pizza topping.
    options: (
      [
        ["Bacon", "Bacon", 2], ["Bell Pepper", "Bell pepper", 1.5], ["Black Olives", "Black olives", 1.5],
        ["Brisket", "Brisket", 2], ["Cheddar Cheese", "Cheddar", 1.5], ["Chicken", "Chicken", 2],
        ["Extra Cheese", "Mozzarella", 2], ["Feta", "Feta", 1.5], ["Fresh Basil", "Fresh basil", 0.15],
        ["Fresh Garlic", "Fresh garlic", 0.25], ["Fresh Mushroom", "Mushrooms", 1.5], ["Ham", "Ham", 2],
        ["Hamburger Beef", "Hamburger beef", 2], ["Italian Sausage", "Italian sausage", 2], ["Jalapeño", "Jalapeño", 1.5],
        ["Pepperoni", "Pepperoni", 2], ["Pineapple", "Pineapple", 1.5], ["Red Onion", "Red onion", 1.5],
        ["Ricotta", "Ricotta", 1.5], ["Spinach", "Spinach", 1.5], ["Tomato", "Tomato", 1.5],
      ] as const
    ).map(([name, ingredient, oz]) => ({ name, cents: TOPPING_CENTS, recipe: [[ingredient, oz]] })),
  },
} satisfies Record<string, Group>;

type GroupKey = keyof typeof GROUPS;

// ---------------------------------------------------------------------------
// Categories and items
// ---------------------------------------------------------------------------

type Item = {
  name: string;
  description?: string;
  cents: number;
  soldOut?: true;
  image?: string;
  groups?: GroupKey[];
  /** What the item comes with, by option name across its groups; preselected and removable. */
  defaults?: string[];
  recipe?: Use[];
  /** Usage per size, one set of lines per option of the item's Size group. */
  sized?: (size: Size) => Use[];
};
type Category = { name: string; station: KitchenStation; items: Item[] };

const IMG = "https://d1w7312wesee68.cloudfront.net";
const TOAST_IMG = (path: string, file: string) =>
  `${IMG}/${path}/resize:fit:1080:1080/plain/s3://toasttab/menu_service/restaurants/8f10c155-b659-4079-9e8d-32163578651e/MenuItem/${file}.jpg`;

const DOUGH: Record<Size, string> = {
  "12in": "Dough ball 12in",
  "14in": "Dough ball 14in",
  "16in": "Dough ball 16in",
  "18in": "Dough ball 18in",
};

type Pie = "standard" | "bbq" | "emiliano" | "texan" | "whiteTrio";

/**
 * What a pie uses at a size beyond its sauce and toppings, which are its
 * defaults and deplete through their own options' recipes.
 */
function pieRecipe(pie: Pie, size: Size): Use[] {
  const s = (oz: readonly [number, number, number, number], share = 1) => at(size, oz) * share;
  const base: Use[] = [[DOUGH[size], 1], ["Mozzarella", s(CHEESE)]];
  switch (pie) {
    case "standard":
      return base;
    case "bbq":
      return [...base, ["Red pepper flakes", s(PINCH)]];
    case "emiliano":
      return [[DOUGH[size], 1], ["Mozzarella", s(CHEESE, 0.75)], ["Red sauce", s(SAUCE, 0.5)]];
    case "texan":
      // Toast has no description for the Texan Rattlesnake; only the dough is known.
      return [[DOUGH[size], 1]];
    case "whiteTrio":
      return [...base, ["Pecorino Romano", s(PINCH, 3)]];
  }
}

const PIE_GROUPS: GroupKey[] = ["size", "sauce", "toppings", "cookTime"];
const SPECIALTY_GROUPS: GroupKey[] = ["size", "sauce", "toppings", "swap", "cookTime"];

const PIZZAS: Item[] = [
  {
    name: "Cheese / Custom",
    cents: 1199,
    image: TOAST_IMG("UKxyHWw7BTSo--WSckfdttch2ldxA9E4mPIRBwJVjyo", "27a64d93-84dd-4cc4-bdfd-beb6258897c7"),
    groups: PIE_GROUPS,
    defaults: ["Red Sauce"],
    sized: (size) => pieRecipe("standard", size),
  },
  {
    name: "The Alfredo Spesh",
    description: "Alfredo Sauce served with Chicken, Bacon, and Spinach.",
    cents: 1799,
    groups: PIE_GROUPS,
    defaults: ["Alfredo Sauce", "Chicken", "Bacon", "Spinach"],
    sized: (size) => pieRecipe("standard", size),
  },
  {
    name: "BBQ Chicken",
    description: "BBQ chicken, red onion, bacon, red pepper flakes, and mozzarella",
    cents: 1799,
    image: TOAST_IMG("8B3pV8Zsomp20yNZBqc44WJu4FG0a6XQMu2TMJzzuos", "e3a4cdaf-2108-46b7-8d65-1c509d78eb39"),
    groups: SPECIALTY_GROUPS,
    defaults: ["BBQ Sauce", "Chicken", "Red Onion", "Bacon"],
    sized: (size) => pieRecipe("bbq", size),
  },
  {
    name: "Emiliano Special",
    description: "Garlic and basil olive oil with dollops of mozzarella and red sauce",
    cents: 1799,
    image: TOAST_IMG("3h4DztE_-R4DESgLXh9t6fU8FK2pwKLMeBUO8CAAu7A", "fc4ae710-8d26-4818-ac4e-35e4bd5c6e24"),
    groups: SPECIALTY_GROUPS,
    defaults: ["Garlic & Basil Olive Oil", "Fresh Garlic", "Fresh Basil"],
    sized: (size) => pieRecipe("emiliano", size),
  },
  {
    name: "Hawaiian",
    description: "Ham, pineapple, red sauce, and mozzerella",
    cents: 1599,
    image: TOAST_IMG("cEsk-wg4FH93MTfpif30F2nQ2X2eRdym4zIcHt50Pv4", "09a5126d-9298-4a84-93cd-714318659ed5"),
    groups: SPECIALTY_GROUPS,
    defaults: ["Red Sauce", "Ham", "Pineapple"],
    sized: (size) => pieRecipe("standard", size),
  },
  {
    name: "Hot Honey Buffalo Chicken",
    description: "Hot honey buffalo sauce, chicken, bacon, and mozzarella",
    cents: 1799,
    image: TOAST_IMG("TbGZw2mNe4RDanvZPPZj7QEAliQ2gOn2GhoSQW6dL7k", "9e3a0455-c2d3-44cd-8cfa-578a737981a2"),
    groups: SPECIALTY_GROUPS,
    defaults: ["Buffalo Sauce", "Chicken", "Bacon", "Texas Hot Honey"],
    sized: (size) => pieRecipe("standard", size),
  },
  {
    name: "Meat Lovers",
    description: "Pepperoni, ham, hamburger beef, Italian sausage, bacon, mozzarella, and red sauce",
    cents: 1799,
    groups: SPECIALTY_GROUPS,
    defaults: ["Red Sauce", "Pepperoni", "Ham", "Hamburger Beef", "Italian Sausage", "Bacon"],
    sized: (size) => pieRecipe("standard", size),
  },
  {
    name: "Supreme",
    description: "Pepperoni, ham, sausage, hamburger beef, bell pepper, red onion, black olives, mushroom, mozzarella, and red sauce",
    cents: 1799,
    image: TOAST_IMG("FBnu30TfEH2cBiqu3PLXvjeUokxQSPdX3vtEyEAk4ac", "c456101c-e8d3-4826-8f80-54d85d1009d4"),
    groups: SPECIALTY_GROUPS,
    defaults: ["Red Sauce", "Pepperoni", "Ham", "Italian Sausage", "Hamburger Beef", "Bell Pepper", "Red Onion", "Black Olives", "Fresh Mushroom"],
    sized: (size) => pieRecipe("standard", size),
  },
  {
    name: "Texan Rattlesnake",
    cents: 1799,
    groups: PIE_GROUPS,
    defaults: ["Red Sauce"],
    sized: (size) => pieRecipe("texan", size),
  },
  {
    name: "Veggie Lovers",
    description: "Bell pepper, onion, black olives, sauteed mushroom, mozzarella, and red sauce",
    cents: 1799,
    groups: SPECIALTY_GROUPS,
    defaults: ["Red Sauce", "Bell Pepper", "Red Onion", "Black Olives", "Fresh Mushroom"],
    sized: (size) => pieRecipe("standard", size),
  },
  {
    name: "White Trio Pie",
    description: "Garlic and Basil Olive Oil with Mozzarella, Dollops of Fresh Ricotta, Pecorino Romano Cheese, and Fresh Basil.",
    cents: 1799,
    image: TOAST_IMG("hj1mWOptEsKJEzxyr5TUtiS6v-koYdTQF4T5O_2iHQ4", "d53dc4db-54ee-4088-8c41-affabc4bdf02"),
    groups: PIE_GROUPS,
    defaults: ["Garlic & Basil Olive Oil", "Ricotta", "Fresh Basil"],
    sized: (size) => pieRecipe("whiteTrio", size),
  },
  {
    name: '12" Gluten Free Cheese or Custom',
    cents: 1299,
    groups: ["sauce", "toppings", "cookTime"],
    defaults: ["Red Sauce"],
    recipe: [["Gluten-free crust 12in", 1], ["Mozzarella", at("12in", CHEESE)]],
  },
];

const CATEGORIES: Category[] = [
  {
    name: "Appetizers",
    station: "kitchen",
    items: [
      {
        name: "Garlic Knots 6Ct",
        description:
          "Freshly baked from our Made From Scratch Dough, these soft and fluffy knots are brushed with rich garlic butter, topped with herbs and parmesan, and served with a warm cup of our signature marinara.",
        cents: 599,
        soldOut: true,
        image: TOAST_IMG("hpHpFeZh0t5LFD-zDC8iBikV1FIf-fT2Vaa8Ork6aUk", "c341a7b7-61a8-4d5f-beae-b518d6594d39"),
        recipe: [["Dough ball 12in", 1], ["Garlic butter", 1], ["Red sauce", 2]],
      },
      {
        name: "Cheesy Garlic Knots 6Ct",
        description:
          "Freshly baked from our Made From Scratch Dough, these soft and fluffy knots are brushed with rich garlic butter, mozzarella and cheddar cheese, topped with herbs and parmesan, and served with a warm cup of our signature marinara.",
        cents: 749,
        soldOut: true,
        image: TOAST_IMG("8-Poc0rp2I98Jgqqte6RPXM_ROPaUSIYdxfWfVsB2_E", "1850824a-115d-4993-9305-3eec186a46a8"),
        recipe: [["Dough ball 12in", 1], ["Garlic butter", 1], ["Mozzarella", 2], ["Cheddar", 1], ["Red sauce", 2]],
      },
      {
        name: "Cheesy Bread",
        cents: 700,
        soldOut: true,
        recipe: [["Dough ball 12in", 1], ["Garlic butter", 1], ["Mozzarella", 4], ["Cheddar", 1]],
      },
    ],
  },
  {
    name: "Salads",
    station: "kitchen",
    items: [
      {
        name: "Caesar Salad",
        description:
          "Crisp House prepared lettuce topped with crunchy croutons and shaved Pecorino Romano, served with our creamy Caesar dressing on the side.\nAdd grilled chicken!",
        cents: 899,
        image: TOAST_IMG("e4pjlVyfxG9CyHsixZWXtReOMwn7g75BsFDVCV_FZyU", "854ef3ee-cd0b-41a8-b462-844eae91d854"),
        groups: ["dressing", "saladProtein"],
        recipe: [["Lettuce", 5], ["Croutons", 1], ["Pecorino Romano", 0.5]],
      },
      {
        name: "Greek Salad",
        description:
          "Crisp Lettuce topped with juicy tomatoes, red onions, mushrooms, pepperoncini, black olives, and crumbled feta, served with our house-made Greek vinaigrette on the side. Fresh, flavorful, and perfect on its own — or add grilled chicken to make it a meal.",
        cents: 999,
        image: TOAST_IMG("OQoEJWxe2wI9SGpuEmIdjogmL7c7X0YnH6BpgCSEJdY", "b6ce74b8-a253-4e2b-81f3-7ad099a10fcb"),
        groups: ["dressing", "saladProtein"],
        recipe: [["Lettuce", 5], ["Tomato", 1.5], ["Red onion", 0.75], ["Mushrooms", 1], ["Pepperoncini", 0.75], ["Black olives", 0.75], ["Feta", 1]],
      },
      {
        name: "Side Salad",
        description:
          "A simple mix of crisp lettuce, fresh tomatoes, pepperoni slices, and crunchy croutons. Light, tasty, and the perfect add-on to any meal.\nComes with your choice of dressing on the side.",
        cents: 499,
        image: TOAST_IMG("wszkEICisHOjA2V2qLoCLGkNyjPntvKhX-oiFzZUmbU", "6597b5ef-94d8-4d87-a989-dcd53f8d0aa7"),
        groups: ["dressing", "saladProtein"],
        recipe: [["Lettuce", 3], ["Tomato", 1], ["Pepperoni", 0.5], ["Croutons", 0.5]],
      },
    ],
  },
  { name: "Pizza", station: "pizza", items: PIZZAS },
  {
    name: "Jumbo Wings",
    station: "kitchen",
    items: [
      {
        name: "5 Count Jumbo Wings",
        description: "5 Big, Crispy, and Full of Flavor Wings. Served with a side of Ranch.",
        cents: 799,
        image: TOAST_IMG("CUgBl3OkSwZe-lYbRadfE-anvUDwjvu90l9jv4PZXgc", "8f6a8de0-922e-468f-af8d-e5e3be92bf73"),
        groups: ["wingFlavor"],
        recipe: [["Jumbo chicken wing", 5], ["Ranch dressing", 2]],
      },
      {
        name: "10 Count Jumbo Wings",
        description: "10 Big, crispy, and full of flavor. Served with a side of 2 Ranch cups",
        cents: 1499,
        image: TOAST_IMG("ED6DuWj41U58TWswTpruOY1aE3oHIZKEELzIkqqrY5E", "dfee9046-06f4-4d9d-8306-68d6a0fde35d"),
        groups: ["wingFlavor"],
        recipe: [["Jumbo chicken wing", 10], ["Ranch dressing", 4]],
      },
    ],
  },
  {
    name: "20 oz bottles",
    station: "counter",
    items: [
      { name: "Pepsi 20oz", cents: 299, recipe: [["Pepsi 20oz", 1]] },
      { name: "Pepsi Zero Sugar 20oz", description: "Enjoy the great taste of Coca-Cola with zero sugar, zero calories", cents: 299, recipe: [["Pepsi Zero Sugar 20oz", 1]] },
      { name: "Starry 20oz", description: "Classic, cool, crisp lemon-lime flavored taste that's caffeine free", cents: 299, recipe: [["Starry 20oz", 1]] },
      { name: "Gatorade 20oz", cents: 299, recipe: [["Gatorade 20oz", 1]] },
    ],
  },
  {
    name: "2L",
    station: "counter",
    items: [
      { name: "Pepsi 2L", description: "Coca-Cola Original Taste — the crisp, refreshing taste you know and love", cents: 399, soldOut: true, recipe: [["Pepsi 2L", 1]] },
      { name: "Pepsi Zero 2L", cents: 399, recipe: [["Pepsi Zero 2L", 1]] },
      { name: "Starry 2L", description: "Classic, cool, crisp lemon-lime flavored taste that's caffeine free", cents: 399, recipe: [["Starry 2L", 1]] },
    ],
  },
  {
    name: "Desserts",
    station: "counter",
    items: [
      { name: "Cheesecake", cents: 499, soldOut: true, recipe: [["Cheesecake slice", 1]] },
      { name: "Chocolate Mousse Cake", cents: 599, soldOut: true, recipe: [["Chocolate mousse cake slice", 1]] },
      { name: "Cannoli", cents: 499, recipe: [["Cannoli", 1]] },
      { name: "Tiramisu", cents: 599, soldOut: true, recipe: [["Tiramisu slice", 1]] },
      { name: "Lemoncello", cents: 599, soldOut: true, recipe: [["Lemoncello cake slice", 1]] },
    ],
  },
  {
    name: "Sauce/Dressings",
    station: "counter",
    items: [
      { name: "Ranch", cents: 99, recipe: [["Ranch dressing", 2]] },
      { name: "Ceasar", cents: 99, recipe: [["Caesar dressing", 2]] },
      { name: "Italian", cents: 99, recipe: [["Italian dressing", 2]] },
      { name: "Greek", cents: 99, recipe: [["Greek vinaigrette", 2]] },
      { name: "Buffalo", cents: 99, recipe: [["Buffalo sauce", 2]] },
      { name: "Marinara", cents: 99, recipe: [["Red sauce", 2]] },
    ],
  },
  {
    name: "Calzones",
    station: "pizza",
    items: [
      {
        name: "Create Your Own Calzone",
        description: "Create Your Own Calzone",
        cents: 1299,
        groups: ["calzoneToppings"],
        recipe: [["Dough ball 14in", 1], ["Mozzarella", 4], ["Red sauce", 2]],
      },
      {
        name: "The Original Calzone",
        description: "Mozzarella, Ricotta, and Ham. Served with a side of Marinara",
        cents: 1299,
        groups: ["calzoneToppings"],
        recipe: [["Dough ball 14in", 1], ["Mozzarella", 4], ["Ricotta", 3], ["Ham", 3], ["Red sauce", 2]],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

/** Toast's "All Day Everyday Steals" item, as the bundle deal it really is. */
const DEAL = {
  name: "2 Large 1-Topping Pizzas, $16.49 Each",
  item: "Cheese / Custom",
  size: 'Large 16"',
  quantity: 2,
  priceCents: 1649,
  includedToppings: 1,
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type ImportSummary = {
  categories: number;
  items: number;
  soldOut: number;
  groups: number;
  modifiers: number;
  ingredients: number;
  recipeLines: number;
  promotion: string;
};

/** Ounces (or pieces) → milli base units for `ingredient`. */
function qtyMilli(ingredient: Ingredient, qty: number): number {
  return Math.round(ingredient.unit === "each" ? qty * 1000 : qty * OZ * 1000);
}

/**
 * Replaces the whole menu (categories, items, modifier groups) and the
 * recipe book with Emiliano's. Past orders keep their snapshots; their
 * `menu_item_id` goes null. Ingredients that already carry inventory moves
 * are kept and reused by name, so the ledger is never touched.
 */
export async function importEmilianosMenu(db: Db): Promise<ImportSummary> {
  const promotions = await db.select({ id: schema.promotions.id, name: schema.promotions.name }).from(schema.promotions);
  const others = promotions.filter((p) => p.name !== DEAL.name);
  if (others.length > 0) {
    throw new Error(
      `Promotions target menu ids that this import replaces (${others.map((p) => p.name).join(", ")}). Remove them first, then re-create them on the new menu.`,
    );
  }

  const ledgered = (
    await db.selectDistinct({ id: schema.inventoryMoves.ingredientId }).from(schema.inventoryMoves)
  ).map((r) => r.id);

  await db.batch([
    db.delete(schema.recipeLines),
    db.delete(schema.stockOuts),
    db.delete(schema.categories),
    db.delete(schema.modifierGroups),
    ledgered.length
      ? db.delete(schema.ingredients).where(notInArray(schema.ingredients.id, ledgered))
      : db.delete(schema.ingredients),
  ]);

  // Ingredients
  const kept = ledgered.length
    ? await db.select({ id: schema.ingredients.id, name: schema.ingredients.name }).from(schema.ingredients).where(inArray(schema.ingredients.id, ledgered))
    : [];
  const ingredientId = new Map(kept.map((r) => [r.name, r.id]));
  const shelf = new Map<string, number>();
  const fresh = INGREDIENTS.filter((i) => !ingredientId.has(i.name)).map((i) => {
    const shelfOrder = shelf.get(i.area) ?? 0;
    shelf.set(i.area, shelfOrder + 1);
    return { name: i.name, baseUnit: i.unit, unitCostMillicents: unitCost(i), storageArea: i.area, shelfOrder };
  });
  const insertedIngredients = fresh.length
    ? await db.insert(schema.ingredients).values(fresh).returning({ id: schema.ingredients.id, name: schema.ingredients.name })
    : [];
  for (const r of insertedIngredients) ingredientId.set(r.name, r.id);
  const ingredientByName = new Map(INGREDIENTS.map((i) => [i.name, i]));

  type Line = typeof schema.recipeLines.$inferInsert;
  const lines: Line[] = [];
  const addLines = (owner: Pick<Line, "menuItemId" | "modifierId">, uses: Use[] = [], sizeModifierId: number | null = null) => {
    const merged = new Map<string, number>();
    for (const [name, qty] of uses) merged.set(name, (merged.get(name) ?? 0) + qty);
    for (const [name, qty] of merged) {
      const ingredient = ingredientByName.get(name);
      const id = ingredientId.get(name);
      if (!ingredient || id === undefined) throw new Error(`Unknown ingredient "${name}"`);
      lines.push({ ...owner, sizeModifierId, ingredientId: id, qtyMilli: qtyMilli(ingredient, qty) });
    }
  };

  // Modifier groups
  const groupKeys = Object.keys(GROUPS) as GroupKey[];
  const groupRows = await db
    .insert(schema.modifierGroups)
    .values(groupKeys.map((key, i) => {
      const g: Group = GROUPS[key];
      return { name: g.name, role: g.role, minSelect: g.min, maxSelect: g.max, sortOrder: i };
    }))
    .returning({ id: schema.modifierGroups.id });
  const groupId = new Map(groupKeys.map((key, i) => [key, groupRows[i].id]));

  const modifierValues = groupKeys.flatMap((key) =>
    (GROUPS[key] as Group).options.map((o, sortOrder) => ({
      groupId: groupId.get(key)!,
      name: o.name,
      priceDeltaCents: o.cents ?? 0,
      isDefault: o.isDefault ?? false,
      isAvailable: o.available ?? true,
      sortOrder,
    })),
  );
  const modifierRows = await db.insert(schema.modifiers).values(modifierValues).returning({ id: schema.modifiers.id });
  const options = groupKeys.flatMap((key) => (GROUPS[key] as Group).options.map((option) => ({ key, option })));
  const modifierId = options.map((_, i) => modifierRows[i].id);
  /** Every Size option across the size groups, so a sized topping line exists for whichever group a pie uses. */
  const sizeOptions = options.flatMap(({ key, option }, i) => (option.size ? [{ key, size: option.size, id: modifierId[i] }] : []));
  options.forEach(({ option }, i) => {
    const owner = { menuItemId: null, modifierId: modifierId[i] };
    addLines(owner, option.recipe);
    if (option.sized) for (const s of sizeOptions) addLines(owner, option.sized(s.size), s.id);
  });

  // Categories and items
  const categoryRows = await db
    .insert(schema.categories)
    .values(CATEGORIES.map((c, sortOrder) => ({ name: c.name, station: c.station, sortOrder })))
    .returning({ id: schema.categories.id });
  const flat = CATEGORIES.flatMap((c, ci) => c.items.map((item, sortOrder) => ({ item, categoryId: categoryRows[ci].id, sortOrder })));
  const itemRows = await db
    .insert(schema.menuItems)
    .values(flat.map(({ item, categoryId, sortOrder }) => ({
      categoryId,
      name: item.name,
      description: item.description ?? null,
      basePriceCents: item.cents,
      imageUrl: item.image ?? null,
      isAvailable: !item.soldOut,
      sortOrder,
    })))
    .returning({ id: schema.menuItems.id });

  const links = flat.flatMap(({ item }, i) => {
    const defaults = new Set(item.defaults);
    const links = (item.groups ?? []).map((key, sortOrder) => {
      const picked = options.flatMap(({ key: k, option }, j) => (k === key && defaults.delete(option.name) ? [modifierId[j]] : []));
      return { itemId: itemRows[i].id, groupId: groupId.get(key)!, sortOrder, defaultModifierIds: picked };
    });
    if (defaults.size > 0) throw new Error(`"${item.name}" defaults to options it doesn't offer: ${[...defaults].join(", ")}`);
    return links;
  });
  if (links.length) await db.insert(schema.itemModifierGroups).values(links);
  flat.forEach(({ item }, i) => {
    const owner = { menuItemId: itemRows[i].id, modifierId: null };
    addLines(owner, item.recipe);
    const sized = item.sized;
    if (!sized) return;
    const sizeKey = item.groups?.find((key) => GROUPS[key].role === "size");
    if (!sizeKey) throw new Error(`"${item.name}" has a sized recipe but no Size group`);
    for (const s of sizeOptions.filter((o) => o.key === sizeKey)) addLines(owner, sized(s.size), s.id);
  });

  for (let i = 0; i < lines.length; i += 500) {
    await db.insert(schema.recipeLines).values(lines.slice(i, i + 500));
  }

  // The deal, pointed at the new ids; updated in place on a re-run so its redemptions stay attached.
  const dealItem = flat.findIndex(({ item }) => item.name === DEAL.item);
  const dealSize = options.findIndex(({ key, option }) => key === "size" && option.name === DEAL.size);
  if (dealItem < 0 || dealSize < 0) throw new Error(`The deal needs "${DEAL.item}" and "${DEAL.size}" on the menu`);
  const reward = promotionRewardSchema.parse({
    type: "bundle",
    target: { categoryIds: [], itemIds: [itemRows[dealItem].id], modifierIds: [modifierId[dealSize]] },
    quantity: DEAL.quantity,
    priceCents: DEAL.priceCents,
    includedToppings: DEAL.includedToppings,
    maxApplications: null,
  });
  const existing = promotions.find((p) => p.name === DEAL.name);
  if (existing) {
    await db.update(schema.promotions).set({ reward, updatedAt: new Date() }).where(eq(schema.promotions.id, existing.id));
  } else {
    await db.insert(schema.promotions).values({ name: DEAL.name, trigger: "automatic", reward, orderTypes: ["pickup", "delivery"] });
  }

  return {
    categories: categoryRows.length,
    items: itemRows.length,
    soldOut: flat.filter(({ item }) => item.soldOut).length,
    groups: groupRows.length,
    modifiers: modifierRows.length,
    ingredients: INGREDIENTS.length,
    recipeLines: lines.length,
    promotion: DEAL.name,
  };
}
