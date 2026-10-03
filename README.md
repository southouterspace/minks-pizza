# Mink's Pizza — Online Ordering Platform

A complete online ordering platform for a single pizzeria: a public storefront
where customers browse the menu, customize pizzas, and place pickup/delivery
orders, plus an operator dashboard for menu management, store settings, and a
live orders inbox.

Payments are intentionally **not** captured yet — orders are persisted with
`payment_status = 'pending'` and the checkout path has a clean seam where
Stripe will slot in (see [Stripe readiness](#stripe-readiness)).

## Stack

- **Next.js 16** (App Router, Server Components, Server Actions), TypeScript
- **Tailwind CSS v4** + **shadcn/ui** (Base UI variant, Nova preset) — minimal
  Vercel-style design system
- **Neon Postgres** + **Drizzle ORM** (`@neondatabase/serverless` over HTTP)
- **Auth**: email + password for the operator (bcrypt), jose-signed JWT session cookie

### UI components

Components live in `src/components/ui/` and are built on
[Base UI](https://base-ui.com) primitives with the shadcn **Nova** preset.
Component styles are the `.cn-*` classes in `src/styles/style-nova.css`, scoped
by the `style-nova` class on `<html>`; design tokens live in
`src/app/globals.css`. `components.json` records the configuration, so
`npx shadcn@latest add <component>` will add more in the same style.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in values (see below)
npm run db:push              # create tables in your Neon database
npm run db:seed              # optional: store settings + starter pizzeria menu
npm run dev
```

`.env.local`:

| Variable | Purpose |
|---|---|
| `MINKS_DATABASE_URL` (or `DATABASE_URL`) | Neon Postgres connection string. `MINKS_DATABASE_URL` wins when both are set. |
| `SESSION_SECRET` | 32+ byte hex secret for session cookies (`openssl rand -hex 32`) |

## The two sides of the platform

### Operator (`/admin`)

1. Visit `/admin` — on first run you're redirected to **/admin/setup** to create
   your operator account.
2. **Menu** — create categories, items, and prices; attach modifier groups
   (Size, Crust, Toppings…); toggle availability to 86 an item instantly.
3. **Modifiers** — reusable option groups with required/optional rules
   (`minSelect`/`maxSelect`) and per-option price deltas.
4. **Settings** — store identity (including a **logo**: upload an image up to
   4 MB or paste a hosted URL; it renders at its natural shape in place of the
   initial badge), hours, pickup/delivery toggles, prep times, delivery
   fee/minimum, tax rate — and the **Publish** switch that takes the storefront
   live (before that, customers see a coming-soon page). A separate
   **Accepting orders** switch pauses ordering without unpublishing.
5. **Orders** (`/admin`) — the live board. See [Order management](#order-management) below.
6. **Kitchen display** (`/kitchen`) — the full-screen KDS for the line. See
   [Kitchen display](#kitchen-display-kds) below.
7. **Team** (`/admin/team`) — add or remove operator accounts, and change your
   own password. See [Operator accounts](#operator-accounts) below.

#### Order management

**Orders board** (`/admin`). A strip of today's numbers (orders, net sales,
average ticket, average placed-to-ready time, orders late right now), then
three lanes: **New**, **In kitchen** (confirmed and preparing) and **Ready**.
Each card shows the order number, customer, type, items, total, how long ago
it was placed and the promised time, which turns red with a **Late** flag
once it passes. The primary button moves the order one step along
`new → confirmed → preparing → ready → completed`; **+5** and **+10** push the
promised time; **Cancel** asks for a reason. The board refreshes every 15
seconds. When a new order arrives the tab chimes and its title flashes
"(1) New order" until someone taps the page; **Chime on/off** is remembered
per device. Browsers only allow sound after the first tap on the page.

Two tablets tapping the same button apply it once: the second tap gets
"Order is already confirmed." Every move is checked against one table of
legal transitions (`src/lib/order-workflow.ts`) that the kitchen display uses
too.

**History** (`/admin/orders`). Search by order number, customer name, email
or phone (digits only, so `246-8135` finds `(555) 246-8135`), and filter by
status, type and a date range in the store's time zone. The URL carries the
filters, so a search can be bookmarked or shared. **Export CSV** downloads the
same rows (up to 5,000).

**Order detail** (`/admin/orders/<id>`). Customer with tap-to-call, items with
modifiers and notes, totals, and the promised time. From here you can
advance or cancel, push the promised time (−5 to +15 min), record payment as
cash, card or other, and add internal notes. The **timeline** lists
everything that happened to the order with who did it and when: the
customer placing it, each operator action, and each status change the
kitchen display made (shown as "Kitchen display · <operator>"). **Print
ticket** prints an 80 mm receipt without the admin chrome.

**Promised time.** Checkout quotes placed time + the pickup or delivery prep
minutes from Settings. The customer's tracker shows "Ready around 6:45 PM"
while the order is cooking and the cancel reason if it was canceled.

**Time zone.** Settings → Time zone decides when the store's day starts for
the board numbers and history dates, and the clock that promised times are
shown in. Default: Central.

##### Deploying the order-management schema

Additive: two enums, an `order_events` table, five nullable `orders` columns
and `store_settings.timezone` with a default. Migrate before deploying the
code:

```bash
MINKS_DATABASE_URL=<production url> npm run db:push
```

Orders placed before the migration have no promised time and no audit rows;
their timeline starts with a synthetic "Order placed".

#### Operator accounts

`/admin/setup` is a **first-run-only** page: it creates the very first operator
and then locks itself permanently — both the page and the server action bail out
to `/admin/login` once any operator exists. There is no public sign-up, because
an open sign-up on `/admin` would let any visitor create an admin account on a
live store.

Every subsequent account is created from **Team** by someone already signed in.
The creator sets an initial password and passes it on out of band; the new
operator can replace it from the same page. Two things to know:

- **There are no roles.** Every operator has full access to the menu, orders and
  settings.
- **You cannot remove your own account.** That restriction is what guarantees at
  least one operator always exists — at zero accounts `/admin/setup` would
  unlock itself and the store could be claimed by anyone.

#### Inventory and food cost

**Toppings by half and portion.** A modifier group's kind (Modifiers page)
decides how it behaves: **Size** picks which recipe quantities apply,
**Toppings** lets customers put each topping on the whole pizza or one half
and choose light, regular or extra. A half topping costs the share of its
price set in Settings (50% by default); extra is offered only on toppings that
have an extra price. The server reprices every choice at checkout, and the
order line records which modifier, which half and how much, so the kitchen
display groups toppings under WHOLE, L and R.

**Ingredients and recipes** (`/admin/inventory/ingredients`, item editor,
Modifiers page). An ingredient has a base unit (grams, millilitres or each),
a cost entered per any purchase unit or custom pack ("case of 4 × 5 lb"), a
storage area and shelf order, and optional low-stock and 86 thresholds. Items
and topping modifiers carry a recipe per size; a size column overrides "All
sizes". Halves and portions scale a topping's quantity by the factors in
Settings (half 50%, light 50%, extra 150% by default). A negative quantity on
an option ("No onions") removes that much from the pizza. The item editor
shows plate cost and margin for each size.

**The stock ledger.** Every change to stock is an appended
`inventory_moves` row: a sale, a delivery, waste or a count. On hand is the
sum; nothing is overwritten. A completed order holds its recipe usage, and any
other status holds none. Every status change brings the order's sale moves in
line in the same database transaction, so the kitchen display's recall gives
the stock back and completing again takes it once. Each order line keeps its
food cost from the moment it completed.

**Counts, waste and deliveries** (`/admin/inventory`). Full counts run by
storage area in shelf order; a spot count lists the five ingredients with the
most sales dollars in the last 7 days. Each entry is saved on the device as
it's typed. A count posts counted minus on hand, so the count itself is the
variance since the last one. Deliveries update each ingredient's cost and warn
when it moved more than 5% from the last delivery.

**Auto-86.** Once an ingredient has been received or counted, falling to its
86 threshold turns off every item and option whose recipe uses it, notes it on
the order that crossed it, and shows a red banner across the admin. Turning an
item back on by hand sticks. A delivery or count that lifts the stock above
the threshold turns back on exactly what inventory turned off.

**Reports** (`/admin/reports`). Food cost % by day, actual vs theoretical
usage for any count (largest cost first, so mozzarella usually leads), topping
mix by size (attach rate, halves, light and extra), and margin by item and
size, flagged below the minimum margin in Settings. Each exports to CSV.

##### Deploying the inventory schema

Additive: new enums and tables, nullable or defaulted columns on
`modifier_groups`, `modifiers`, `order_items` and `store_settings`. Migrate
before deploying the code, then mark the size and topping groups:

```bash
MINKS_DATABASE_URL=<production url> npm run db:push
```

```sql
update modifier_groups set kind = 'size'     where name ilike 'size%';
update modifier_groups set kind = 'toppings' where name ilike '%topping%';
```

`npx tsx --env-file=<env file> scripts/seed-inventory.ts` adds a starter set of
ingredients and per-size recipes for the seeded menu. It is idempotent and
sets no 86 thresholds. Orders placed before the migration have no modifier
ids, so they render as before and are never depleted.

### Kitchen display (KDS)

`/kitchen` is a full-screen, dark, touch-first kitchen display built from
operator feedback on Toast, Square and other KDS products, weighted toward
pizzerias (see `docs/kds-research.md`). Open it on any tablet or TV signed in
as an operator and tap **Start kitchen display** once, so it can chime and keep
the screen awake.

**Stations.** Each menu category routes to a station (Menu → category → Edit →
*Kitchen station*): **Pizza line**, **Kitchen** (wings, knots, salads) or
**Counter** (drinks and anything with no prep; shown on the ticket but never
holds an order back). Each order line copies its category's station at
checkout, so re-routing a category doesn't reshuffle tickets already on the
line. Each screen remembers its own station choice:

| Screen | Shows | Tap an item | Bump |
|---|---|---|---|
| All | every open ticket (expo or one-screen shops) | advance one stage | finish the whole order |
| Make line | tickets with pies not yet fired | into the oven | fire every pie on the ticket |
| Oven | pies in the oven, each with a bake countdown | out, cut and boxed | pull every pie on the ticket |
| Kitchen | tickets with non-pizza kitchen items | done | finish the kitchen items |
| Ready | bumped orders waiting for the customer or driver | | picked up / out for delivery |

An order becomes **ready** on its own when every item that needs cooking is
finished, and any tap on its items moves it to **preparing**. The customer's
order tracker reflects both.

**Reading a ticket.** Size and crust come first as chips, because they decide
which dough ball to grab. Toppings show as `+ Pepperoni`. Removals (`No …`)
are red and uppercase, amount changes (`Extra …`, `Light …`) are amber, and
item notes and order notes (allergies) sit in yellow boxes. Quantities above
one are highlighted. The header shows the order number, PICKUP or DELIVERY,
and a timer that turns amber and then red at the thresholds set in
**Settings → Kitchen display**, which also sets the oven bake time.

**During a rush.**
- **All-day** panel (`A`): unmade quantities across all tickets by item and
  size, for example "6 Cheese Pizza Large 14"".
- **Recall** (`R`): orders bumped in the last two hours. Recalling puts the
  ticket back on the line from the start. Every finishing bump also shows an
  **Undo** toast.
- **Bump bar / keyboard:** `1`–`9` or the arrow keys select a ticket, and
  `Enter` or `Space` bumps it. Most USB bump bars send these keys.
- New orders chime and flash. An order canceled while it is on screen raises
  a red "pull it" banner.
- If the connection drops, the tickets stay on screen under a red banner
  that shows when they were last synced. Polling resumes on its own.
- Text size (A−/A+) and the sound toggle are saved per screen.

The display polls `GET /api/kds` every 4 seconds. Taps update the screen
immediately and are sent to `POST /api/kds`. Each action is idempotent, so
a double tap or a retry is harmless.

#### Deploying the KDS schema

The KDS adds columns, so **migrate the production database before deploying
this code**. Checkout reads `categories.station`, so the old schema breaks
ordering.

```bash
MINKS_DATABASE_URL=<production url> npm run db:push   # additive: new enum + columns with defaults
```

Then route the existing categories (or do it in Menu → Edit):

```sql
update categories set station = 'pizza'   where name ilike '%pizza%' or name ilike 'build your own%';
update categories set station = 'counter' where name ilike '%drink%' or name ilike '%beverage%';
```

Orders placed before the migration default to the Kitchen station.

### Customer (`/`)

Menu browsing with category navigation → item customization dialog (sizes,
crusts, toppings with live price updates, quantity, special instructions) →
cart (persisted in localStorage) → checkout (pickup/delivery, contact details,
address for delivery, tip presets, order notes) → order confirmation page with
a live status tracker.

All pricing is authoritative server-side: the cart submits only item/modifier
ids, and the server re-validates availability, modifier rules, delivery
minimums, and recomputes every price at order time.

## Stripe readiness

- Money is integer cents everywhere; `orders` carries a full breakdown
  (subtotal, tax, delivery fee, tip, total) and `payment_status`
  (`pending`/`paid`/`refunded`).
- `src/lib/orders.ts` → `createOrder()` is the single seam: create a
  PaymentIntent for `totalCents` there, store its id, and flip
  `payment_status` from a Stripe webhook. `placeOrder` in
  `src/app/(store)/actions.ts` already returns a structured result to which a
  client secret can be added.

## Project layout

```
src/
  db/            schema.ts (Drizzle), seed.ts, index.ts (client)
  lib/           menu.ts, orders.ts (pricing + creation), auth.ts, validation.ts,
                 order-workflow.ts (order lifecycle rules, pure),
                 order-writes.ts (logged status/ETA/payment/note writes),
                 order-queries.ts (board, history search, export, detail, day stats),
                 kds.ts (kitchen display rules, pure), kds-server.ts (queries + actions),
                 units.ts, unit-entry.ts, toppings.ts, recipes.ts (inventory rules, pure),
                 inventory.ts (stock ledger, counts, deliveries, auto-86),
                 inventory-reports.ts (food cost, variance, topping mix, margins)
  app/(store)/   customer storefront (menu, cart, checkout, order status)
  app/admin/     operator dashboard (orders board, history + detail, menu,
                 modifiers, inventory, reports, settings, team); CSV exports in
                 app/api/admin
  app/kitchen/   kitchen display (KDS); data via app/api/kds
  components/    cart context, storefront + admin UI
```

## Roadmap

Informed by industry research (see `docs/RESEARCH.md`), roughly in order:

1. **Stripe payment capture** — the seam is ready (see above)
2. **Scheduled orders** (ASAP vs later) and rush-aware prep-time estimates
3. **SMS status notifications** — cuts "where's my order" calls
4. **Delivery zones** (radius/ZIP validation, tiered fees)
5. **Allergen/dietary tags & item photos** (schema already has `imageUrl`)
6. **Customer accounts with saved addresses & one-tap reorder** — optional,
   post-purchase (guest checkout stays the default)
7. **Coupons/promo codes**; refunds (the `refunded` payment status exists but
   nothing sets it yet; the stock ledger already treats a refunded order as
   using nothing, so a refund action only needs to batch the same inventory
   sync that status changes do)
8. **KDS follow-ups** (from `docs/kds-research.md`): a kitchen-only role so
   the display tablet doesn't carry full admin access; promised-time sorting once scheduled orders exist

See `NOTES.md` for the build log and decision record.
