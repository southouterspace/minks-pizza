# Reporting and Inventory Research: Feature Parity and Operator Pain

Research date: 2026-10-03. Scope: Toast (with xtraCHEF), Square for Restaurants, Clover, SpotOn, Lightspeed K-Series, TouchBistro, Revel, pizza-first POS systems (HungerRush, SpeedLine, Slice), and back-office tools (MarketMan, MarginEdge, Restaurant365, Craftable).

**Method and limits.** Vendor help centers were the main source for features. Complaints come from Capterra (readable), G2 (search snippets only, because pages returned 403), TrustRadius, BBB, Toast Community and trade press. Reddit is blocked from this environment, so Reddit claims are second-hand through blogs that quote it. Several complaint sources sell competing products; their quotes match the review sites, but their framing is biased. A "?" in a matrix means the vendor's public docs don't say. It does not mean the feature is missing. Pricing comes from third-party sites and is approximate.

---

## 1. Where Mink's stands today

| Area | What exists | Gap |
|---|---|---|
| Reporting | Today-only tiles (`getDashboardStats` in `src/lib/order-queries.ts`), order search, CSV export capped at 5,000 rows | No date ranges, item or modifier mix, daypart, channel, tax, tip, or refund summaries |
| Inventory | `menu_items.is_available` and `modifiers.is_available` (manual 86) | No ingredients, recipes, costs, counts, vendors, waste |
| Order data | `order_items.modifiers` jsonb holds `{groupName, modifierName, priceDeltaCents}` | No modifier ID, placement (half) or amount (light/extra), so topping usage can't be computed reliably |
| Payments | `payment_status` / `payment_method` set by hand | No payments table, so no drawer close, refunds or tip reconciliation |
| Labor | `operators` table, no roles | No time clock, wages or labor % |

Inventory and reporting both depend on the order line knowing **which** modifier was chosen, **where** on the pizza and **how much**. Section 5 makes that change first.

---

## 2. Reporting: parity matrix

**Y** = base product · **$** = paid tier or add-on · **~** = partial · **?** = not documented

| Feature | Toast | Square | Clover | SpotOn | Lightspeed | TouchBistro | Revel | HungerRush | SpeedLine | Slice |
|---|---|---|---|---|---|---|---|---|---|---|
| Sales summary | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Item mix (PMIX) | Y | Y | Y + margin | Y + pairings | Y + quadrant | Y + food cost | Y | Y | Y | Y |
| Modifier report | Y | Y | ? | Y | ? | ? | ? | ? | ? | ? |
| Labor % / OT / sched vs actual | Y | $ Team Plus | ~ | $ Teamwork | Y | $ add-on | Y | Y | ? | ? |
| Discounts / voids / refunds | Y | Y | Y | ~ | Y | Y | Y | Y | Y | Y |
| Hourly / daypart | Y | $ Plus | Y | Y | Y | ? | Y | Y | Y | ? |
| Channel (pickup / delivery / 3P) | Y | ~ | Y | Y | ? | ? | ? | Y | Y | Y |
| Custom report builder | **N** | Y | $ BusinessQ | ~ | ~ | ? | ? | ? | Y (Sisense) | ? |
| Scheduled email of any report | ~ (3 summaries, no PMIX) | ~ | $ | ? | ? | ~ daily sales | Y | ? | ? | ? |
| EOD / Z / cash drawer | Y | $ Plus | Y | Y | ? | Y | ? | ? | Y driver cash-out | Y |
| AI "ask your data" | Y Toast IQ | Y Square AI | $ | Y Profit Assist | Y Lightspeed AI | N? | N? | N | ? | ? |
| Peer benchmarking | Y | ~ | N | N | Y | N | N | N | N | N |
| Delivery ops (driver times, late %, mileage) | ? | ? | ? | ? | ? | ? | ? | Y | Y | Y |

**Table stakes**, which every vendor has: sales summary, item mix, payment-type split, discounts and voids, tips, a mobile-friendly dashboard, CSV export, and an end-of-day report.

**Differentiators**, which only one to three vendors do well:
- AI Q&A (Toast, Square and Lightspeed all shipped it between Oct 2025 and Jan 2026).
- Peer benchmarking.
- Menu-engineering quadrants that use margin.
- Scheduled delivery of *any* report.
- A real custom builder.
- Pizza delivery operations reporting.

---

## 3. Inventory: parity matrix

**Y** = built in · **A** = paid add-on · **P** = partner app only · **L** = limited · **?** = not documented

| Feature | Toast + xtraCHEF | Square | Clover | Lightspeed | Revel | HungerRush | SpeedLine | MarginEdge | R365 | Craftable |
|---|---|---|---|---|---|---|---|---|---|---|
| Recipe / ingredient depletion | A | Y beta / A | L | A | Y | Y | Y | Y | Y | Y |
| Plate cost | A | Y beta | L | A | Y | L | Y | Y | Y | Y |
| Modifier-aware depletion | A | **L (no recipes on size variations)** | ? | ? | Y | Y | **Y (best)** | Y | Y | Y |
| Unit conversion (case → lb → oz) | A | A | ? | ? | Y | ? | ? | Y | Y | Y |
| Theoretical vs actual | A | A | P | ? | ? | ? | Y | Y | Y | Y |
| Mobile counts by storage area | A | A | P | A | Y | ? | Y | Y | Y | Y |
| Waste logging | ? | A | P | ? | ? | ? | Y | ? | Y | Y |
| Auto-86 when stock runs out | Item count only | **Ingredient-driven** | L | Reorder points | ? | ? | ? | Alerts | Alerts | Alerts |
| Purchase orders / vendors | A | A | P | A | Y | ? | ? | Y | Y | Y |
| Invoice OCR + price alerts | A (core) | A | P | N | N | N | N | Y | Y | Y |
| Par / suggested order | ? | A | P | Reorder points | ? | ? | ? | ? | Y | Y |
| Prep forecasting | ? | ? | ? | L | L | ? | ? | ? | Y | L |
| QuickBooks / Xero | A | ? | P | ? | ? | ? | ? | Y | GL | Y |

**Approximate add-on pricing** (per location per month):

| Product | Price |
|---|---|
| xtraCHEF | about $149–349 |
| Square Restaurant Inventory (powered by MarketMan) | $99 |
| MarginEdge | $350 |
| Restaurant365 | from $499 |
| Craftable | from $250 |

### How competitors deplete pizza toppings

This matters most for a pizzeria, because cheese is the largest single cost item.

| Vendor | Approach |
|---|---|
| SpeedLine | Portion depends on **size and number of toppings**. For example, a large 1-topping uses 5 oz of pepperoni, but a large 4-topping uses 3 oz. Handles halves. Its usage report shows where food cost leaks. This is the benchmark. |
| NCR Aloha | Enter the amount for a whole pizza and the system derives ½, ⅓ and ¼ portions. This is the right model for halves. |
| Toast / xtraCHEF | Maps modifiers to products and scales them by size. Supports "subtract" for removed ingredients. Per-size recipes need workarounds, according to the community forum. |
| R365 | One recipe per size × modifier combination. Accurate, but the number of recipes to maintain grows quickly. |
| Craftable | Maps a whole modifier group to one depletion rule. Targets pizza shops explicitly. |
| Square (native) | Cannot attach recipes to size variations, so it can't handle size-priced pizza. |
| TouchBistro | Text modifiers never deplete stock. |

---

## 4. What operators complain about most, and our answer

Ranked by strength of evidence.

| # | Complaint | Evidence | Vendors named | Mink's answer |
|---|---|---|---|---|
| 1 | **Reports are shallow and scattered.** Closing the day takes 4–7 reports, and drill-down stops at the category level. "Reporting is horrific… comps, promos, takeout vs. dine-in" (TouchBistro, Capterra). "Drill-down… stops at the category level" (Square, Capterra). | Strong | TouchBistro, Square, Clover, Toast, Revel | **One close-of-day screen.** Every number drills down to the tickets behind it. Saved views slice by item, modifier, channel, daypart and hour. |
| 2 | **POS inventory is "a chalkboard."** Counts carry no dollar value and there is no recipe deduction, so owners "export spreadsheets and guestimate" (FSR). | Strong | TouchBistro, Square, Clover, base Toast | **Recipe-based depletion with costs from day one.** A weekly theoretical vs actual report is included. |
| 3 | **Real inventory is a separate paid product with a fragile sync.** It costs $99–$499 per location per month, and G2 reviews of MarketMan cite a "disconnect with POS." | Strong | Toast, Square, Lightspeed, Clover | **One database, so nothing to sync.** Inventory is part of the core product. |
| 4 | **Invoice OCR makes duplicates.** Reviews of xtraCHEF say it "assigns the wrong vendor… creates duplicate items." Its G2 score is about 2.4. MarginEdge onboarding takes 7–10 days. | Moderate–strong | xtraCHEF, MarketMan, MarginEdge | **The owner confirms each match.** Show a side-by-side screen for new items, and flag price changes, for example "mozz +12% vs last invoice." Import CSV or EDI from Sysco and US Foods before attempting OCR. |
| 5 | **Counts are slow, and mobile apps crash in the walk-in.** A count takes 1–3 hours. MarketMan reviewers save every 5 minutes so they don't lose work. | Moderate | MarketMan, MarginEdge, TouchBistro | **An offline-first count sheet.** Items appear in shelf order and each entry saves locally. Count in cases, each or by weight. Daily spot counts cover the top 10 cost items, such as cheese, dough and pepperoni. |
| 6 | **Third-party delivery doesn't reconcile.** Commissions of 15–30%, clawbacks and promotions leave "hours manipulating reports." | Moderate (some sources sell reconciliation tools) | Lightspeed, TouchBistro, Square, Clover | **Import payouts and match them to orders.** Show expected vs received and true net margin for each channel. |
| 7 | **Hardware, processor and contract lock-in.** One example is a SpotOn BBB complaint about about $2.6k in cancellation fees. | Strong | Toast, Clover, SpotOn, HungerRush | **Off-the-shelf hardware, any processor and month-to-month terms.** These are business choices, but the product should never require proprietary devices. |
| 8 | **Data export lock-in.** Toast docs state that some reports can't be exported. MarginEdge: "difficult to pull raw data out." | Moderate | Toast, MarginEdge, Revel | **CSV on every report and a one-click "export everything."** Remove the 5,000-row cap. Raw data stays readable because it's the owner's Postgres. |
| 9 | **Price creep and fees per module.** One example is Toast's $0.99 online-order fee, reversed after backlash. | Moderate–strong | Toast, Square, Lightspeed, Clover | **Reporting and inventory stay in the base product.** |
| 10 | **Offline mode fails,** which leaves gaps in reports and stock. "If the internet goes down… printers won't print from the KDS" (Square). | Strong | TouchBistro, Square, Toast, Revel | **Out of scope for an online-ordering build.** The count app must still work offline (see #5). |
| 11 | **Support can't answer data questions,** so custom reports need a ticket. | Strong overall, moderate for reporting | All vendors | **Self-serve views, plus "ask your data" later.** |
| 12 | **Pizza modifiers deplete wrong.** Generic POS systems mishandle halves, size × topping portions, and light or extra amounts, so the theoretical cheese number is wrong. | Moderate | Toast, Square, Clover | **A pizza-native portion model (section 5).** This is the clearest gap Mink's can own. |

---

## 5. Recommended design

### 5.1 Fix the order-line snapshot first

Extend `OrderItemModifier` with the modifier's identity, where it goes on the pizza and how much was requested. Keep the existing name and price snapshot.

```ts
type OrderItemModifier = {
  modifierId: number;              // new: join key for mix and depletion
  groupName: string;
  modifierName: string;
  priceDeltaCents: number;
  placement?: "whole" | "left" | "right";  // new: halves
  amount?: "light" | "regular" | "extra";  // new
};
```

Without `modifierId`, the modifier report and topping depletion must join on names, and names break when an item is renamed. Old orders have no `modifierId`. Backfill them by matching names where possible and accept gaps in their history.

Also snapshot the **theoretical cost** on each `order_items` row when the order is placed (`cost_cents`). COGS reports then stay correct after ingredient prices change.

### 5.2 Inventory as an append-only ledger

```
ingredients        id, name, base_unit (g | ml | each), cost_per_base_unit (micro-cents),
                   par_qty, storage_area, sort_order, is_active
ingredient_units   ingredient_id, unit_name ("case", "lb", "bag"), base_qty   -- case = 4×5 lb
vendors            id, name, contact, order_days
recipe_lines       id, menu_item_id?, modifier_id?, size_modifier_id?, ingredient_id, qty_base
                   -- size_modifier_id null = applies to all sizes
inventory_moves    id, ingredient_id, qty_base (signed), kind (sale | receive | waste |
                   count_adjust | prep), unit_cost, ref (order_item_id | receipt_id | count_id),
                   operator_id, created_at
counts / count_lines    a snapshot per storage area; posts count_adjust moves
receipts / receipt_lines   a vendor invoice; updates cost_per_base_unit and price history
```

- **On-hand is calculated, not stored.** It is the sum of `inventory_moves`. This copies the append-only pattern `order_events` already uses. It makes variance reporting simple: theoretical usage = `sale` moves, and actual usage = opening count + receipts − closing count.
- **Size scaling.** Store `recipe_lines` per size, for example "Pepperoni, Large: 4 oz" and "Pepperoni, Small: 2 oz". Sizes are already modifiers, so `size_modifier_id` points at the existing rows. This avoids R365's explosion of recipes per combination.
- **Halves and amounts.** Multiply the recipe quantity by fixed factors: whole = 1, half = 0.5, light = 0.5, extra = 1.5 by default. Make the factors editable in store settings. This is Aloha's model.
- **Topping-count adjustment** (SpeedLine's model) is optional. Add it only if counts show variance on loaded pizzas.
- **When to write `sale` moves.** Write them when the order moves to `completed`. Reverse them on cancel or refund. Writing at placement would deplete stock for orders that are later canceled.
- **Auto-86.** When an ingredient's on-hand goes below zero or a threshold, mark every item and modifier that uses it unavailable. Use the existing `is_available` flags. Square is the only competitor that 86s from ingredient stock.

### 5.3 Reports, in build order

1. **Date-range sales summary.** Gross, discounts, net, tax, tips, delivery fees, order count, average ticket, pickup vs delivery, and payment method. Use the store's business day and timezone. This is a generalized `getDashboardStats`.
2. **Item mix and modifier mix.** Quantity, sales, % of sales and, once costs exist, margin. A topping-attach rate (for example, "38% of larges get extra cheese") is cheap and pizza-specific.
3. **Hourly and daypart heatmap** (day of week × hour). Use it for staffing and prep.
4. **Close-of-day screen.** Totals, cash expected, cancellations and refunds with operator and reason (already in `order_events`). Each row links to the orders behind it.
5. **Kitchen speed.** Ticket times by hour and late %. The data already exists in `placed_at`, `oven_at`, `done_at`, `ready_at` and `promised_at`. Most generic POS systems don't have this.
6. **Food cost.** Theoretical COGS %, actual vs theoretical variance by ingredient (cheese first), waste log, and a menu-engineering quadrant (popularity × margin).
7. **Scheduled email** of any saved view, sent nightly or weekly. Toast can't email item mix; this beats it.

Every report gets CSV export. Remove the 5,000-row cap by streaming the export.

### 5.4 Deliberately deferred

| Feature | Blocker |
|---|---|
| Labor % | Needs a time clock and wages |
| Cash drawer and tip reconciliation | Needs a payments table, ideally with Stripe |
| Third-party delivery reconciliation | Mink's doesn't take DoorDash or Uber orders yet |
| Multi-location rollups and transfers | `location_id` is not in the schema |
| Invoice OCR | Typed receipts with price-change alerts deliver most of the value. OCR is where competitors get the worst reviews. |
| AI Q&A and benchmarking | These are differentiators, not parity. Revisit once the reporting data is trustworthy. |

---

## 6. Suggested phases

| Phase | Ships | Parity effect |
|---|---|---|
| 1 | Modifier-ID snapshot, date-range summary, item and modifier mix, daypart heatmap, uncapped CSV | Reaches reporting table stakes |
| 2 | Close-of-day screen with drill-down, kitchen speed report, scheduled email | Beats Toast and Square on complaints #1 and #8 |
| 3 | Ingredients, units, per-size recipes, half and extra factors, sale depletion, cost snapshot, theoretical food cost % | Matches xtraCHEF and SpeedLine on pizza depletion without an add-on |
| 4 | Mobile count sheet in shelf order with offline saves, waste log, receipts with price alerts, variance report, auto-86 from stock | Answers complaints #2–#5. Few products do ingredient-driven auto-86. |
| 5 | Par levels and suggested order, menu-engineering quadrant, QuickBooks export | Parity with dedicated back-office tools |

---

## Sources

**Reporting**
- Toast:
  - https://pos.toasttab.com/blog/on-the-line/restaurant-pos-reports
  - https://support.toasttab.com/en/article/Can-I-create-custom-reporting
  - https://community.toasttab.com/t5/back-office-team/schedule-reports-to-be-automatically-emailed/td-p/15927
  - https://support.toasttab.com/en/article/Toast-Benchmarking-Overview
  - https://pos.toasttab.com/products/toast-iq
- Square:
  - https://squareup.com/help/us/en/article/8363-view-item-category-and-modifiers-sales-reports
  - https://squareup.com/help/us/en/article/6104-creating-custom-reports-in-the-online-dashboard
  - https://squareup.com/help/us/en/article/6433-reporting-with-square-for-restaurants
- Clover:
  - https://businessq-software.com/analytics-for-clover-faq-2/
- SpotOn:
  - https://www.spoton.com/solutions/reporting/
- Lightspeed:
  - https://k-series-support.lightspeedhq.com/hc/en-us/articles/18235324645531-Menu-Reports
  - https://k-series-support.lightspeedhq.com/hc/en-us/articles/28846463754523-Understanding-Benchmarks-and-Trends
- Revel:
  - https://support.revelsystems.com/hc/en-us/articles/115001992766-Auto-Delivery-of-Reports-
- Pizza POS:
  - https://www.speedlinesolutions.com/delivery
  - https://slice.com/knowledge-hub/register-cash-management-and-reporting/
  - https://pos.hungerrush.com/pizza-mm

**Inventory**
- Toast / xtraCHEF:
  - https://support.toasttab.com/en/article/xtraCHEF-Recipe-Product-Mix-Mapping
  - https://support.toasttab.com/en/article/xtraCHEF-Get-Started-With-Actual-vs-Theoretical-Analysis-Reports
  - https://community.toasttab.com/t5/restaurant-operations/xtrachef-recipe-with-size-pricing/m-p/10338
- Square:
  - https://squareup.com/help/us/en/article/8629-beta-track-ingredient-costs-with-square-recipes
  - https://squareup.com/us/en/press/square-restaurant-inventory-marketman
- Lightspeed:
  - https://k-series-support.lightspeedhq.com/hc/en-us/articles/4407517428891-About-Advanced-inventory
- Revel:
  - https://support.revelsystems.com/hc/en-us/articles/360021085732-How-to-Attach-Ingredients-to-Modifiers-with-Recipes
- TouchBistro:
  - https://cdn.touchbistro.com/help/articles/working-menu-modifiers/
- SpeedLine:
  - https://www.speedlinesolutions.com/blog/portion-control-reduce-inventory-costs-in-your-pizzeria
- NCR Aloha:
  - https://docs.ncrvoyix.com/restaurant/aloha-pos/implementing/advanced_pizza_qs/configuring_pizza_topping_inventory_depletion
- Back-office tools:
  - https://docs.restaurant365.com/docs/pos-menu-item-modifier-management
  - https://help.craftable.com/learning/release-note
  - https://www.marginedge.com/food-cost

**Complaints**
- Review sites:
  - https://www.capterra.com/p/140677/TouchBistro/reviews/
  - https://www.capterra.com/p/175628/Square-Point-of-Sale/reviews/
  - https://www.capterra.com/p/136301/Toast-POS/reviews/
  - https://www.capterra.com/p/122189/HungerRush360/reviews/
  - https://www.g2.com/products/marketman/reviews
  - https://www.trustradius.com/products/revel-systems/reviews
  - https://www.bbb.org/us/ca/san-francisco/profile/payment-processing-services/spoton-transact-llc-1116-449521/complaints
- Trade press and third-party reviews:
  - https://www.fsrmagazine.com/feature/inventory-management-too-expensive-ignore-and-too-complicated-spreadsheets/
  - https://restaurantinventorymanagementsoftware.com/solutions/xtrachef
  - https://restauranttools.ai/tools/marginedge
- Sources from vendors that sell competing products (biased):
  - https://www.sleftpayments.com/learning-hub/toast-pos-problems-complaints-2026
  - https://www.deliverguard.io/resources/lightspeed-restaurant-end-of-day-problems
  - https://www.orderout.co/blog/reconcile-the-difference/
